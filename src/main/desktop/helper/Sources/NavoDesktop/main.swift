import AppKit
import ApplicationServices
import ScreenCaptureKit

struct Failure: LocalizedError { let message: String; var errorDescription: String? { message } }
func fail(_ text: String) -> Failure { Failure(message: text) }
func emit(_ object: [String: Any]) { if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) } }
func attr(_ node: AXUIElement, _ name: String) -> CFTypeRef? { var value: CFTypeRef?; return AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success ? value : nil }
func string(_ node: AXUIElement, _ name: String) -> String? { attr(node, name) as? String }
func frame(_ node: AXUIElement) -> CGRect? {
  guard let p = attr(node, kAXPositionAttribute), let s = attr(node, kAXSizeAttribute), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero; var size = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
  guard point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { return nil }
  return CGRect(origin: point, size: size)
}
func rect(_ r: CGRect) -> [String: Double] { ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }
func secure(_ node: AXUIElement) -> Bool { string(node, kAXSubroleAttribute) == "AXSecureTextField" || (string(node, kAXRoleAttribute) ?? "").localizedCaseInsensitiveContains("secure") || (attr(node, "AXProtectedContent") as? Bool == true) }
func secureContext(_ node: AXUIElement) -> Bool {
  var current = node
  for _ in 0..<12 {
    if secure(current) { return true }
    guard let parent = attr(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
    current = parent as! AXUIElement
  }
  return false
}
let marker: Int64 = 0x4e41564f
// Keep CGEvent text payloads small without splitting a UTF-16 surrogate pair.
func unicodeChunks(_ text: String) -> [[UInt16]] {
  var chunks: [[UInt16]] = []; var current: [UInt16] = []
  for scalar in text.unicodeScalars {
    let units = Array(String(scalar).utf16)
    if current.count + units.count > 16 { chunks.append(current); current = [] }
    current.append(contentsOf: units)
  }
  if !current.isEmpty { chunks.append(current) }
  return chunks
}

// Match only the selected AX window; z-order alone may select an auxiliary preview.
func selectedScreenshotIndex(_ candidates: [(CGRect, String?)], bounds: CGRect?, title: String?) -> Int? {
  guard let bounds else { return candidates.count == 1 ? 0 : nil }
  let matches = candidates.indices.filter { i in
    let r = candidates[i].0
    return abs(r.minX - bounds.minX) <= 2 && abs(r.minY - bounds.minY) <= 2 && abs(r.width - bounds.width) <= 2 && abs(r.height - bounds.height) <= 2
  }
  let titled = matches.filter { !(title ?? "").isEmpty && candidates[$0].1 == title }
  return titled.count == 1 ? titled[0] : matches.count == 1 ? matches[0] : nil
}

final class Helper {
  let fake = CommandLine.arguments.contains("--fake")
  var refs: [String: (AXUIElement, String, CGRect?)] = [:]
  var serial = 0
  var tap: CFMachPort?
  var tapSource: CFRunLoopSource?
  var stopped = false
  var watching = false
  var mouseAnchor: CGPoint?
  var heldKeys = Set<CGKeyCode>()
  var heldButtons = Set<Int>()
  var fakeText = "Hello Navo"
  var fakeRef = "fake:0"
  let fakeApp: [String: Any] = ["bundleId": "com.apple.TextEdit", "name": "TextEdit", "pid": 123, "windows": ["Untitled"]]
  func appInfo(_ app: NSRunningApplication) -> [String: Any] { ["bundleId": app.bundleIdentifier ?? "", "name": app.localizedName ?? "", "pid": Int(app.processIdentifier), "windows": windows().filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier) }.compactMap { $0[kCGWindowName as String] as? String }] }
  func windows() -> [[String: Any]] { CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [] }
  func find(_ id: String) throws -> NSRunningApplication { guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == id }) else { throw fail("App 未运行：\(id)") }; return app }
  func owner(_ p: CGPoint) -> NSRunningApplication? {
    for w in windows() {
      guard (w[kCGWindowLayer as String] as? Int ?? -1) >= 0, (w[kCGWindowAlpha as String] as? Double ?? 1) > 0, let bounds = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: bounds), r.contains(p), let pid = w[kCGWindowOwnerPID as String] as? Int32 else { continue }
      return NSRunningApplication(processIdentifier: pid)
    }
    return nil
  }
  func guardApp(_ id: String) throws {
    if stopped { throw fail("用户已停止桌面操作，请重新开始") }
    guard AXIsProcessTrusted() else { throw fail("需要在系统设置中允许辅助功能权限") }
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == id else { throw fail("前台 App 已改变，请重新激活目标 App 并获取快照") }
  }
  func node(_ a: [String: Any], _ id: String) throws -> AXUIElement? {
    guard let key = (a["ref"] ?? a["id"]) as? String else { return nil }
    guard let (n, bundle, previousFrame) = refs[key], bundle == id, attr(n, kAXRoleAttribute) != nil else { throw fail("元素引用已失效，请重新获取快照") }
    var pid: pid_t = 0
    guard AXUIElementGetPid(n, &pid) == .success, pid == (try find(id)).processIdentifier else { throw fail("元素引用已失效，请重新获取快照") }
    if secureContext(n) { throw fail("不能读取或操作密码输入框") }
    if let previousFrame { guard let currentFrame = frame(n), previousFrame == currentFrame else { throw fail("元素位置已改变，请重新获取快照") } }
    guard (attr(n, kAXEnabledAttribute) as? Bool) != false else { throw fail("元素当前不可操作，请重新获取快照") }
    return n
  }
  func position(_ a: [String: Any], _ n: AXUIElement?, _ id: String) throws -> CGPoint {
    let p: CGPoint
    if let x = a["x"] as? Double, let y = a["y"] as? Double { p = CGPoint(x: x, y: y) }
    else if let n, let r = frame(n) { p = CGPoint(x: r.midX, y: r.midY) }
    else { throw fail("需要元素引用或屏幕坐标") }
    guard p.x.isFinite && p.y.isFinite, owner(p)?.bundleIdentifier == id else { throw fail("坐标不属于目标 App，请重新截图") }
    var hit: AXUIElement?
    if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success, let hit, secureContext(hit) { throw fail("不能操作密码输入框") }
    return p
  }
  func selectedWindow(_ app: NSRunningApplication) -> AXUIElement? {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    for key in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
      if let value = attr(root, key), CFGetTypeID(value) == AXUIElementGetTypeID() { return (value as! AXUIElement) }
    }
    return nil
  }
  func verifyFocus(_ target: AXUIElement, _ id: String) throws {
    let root = AXUIElementCreateApplication(try find(id).processIdentifier)
    guard let focused = attr(root, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(),
          CFEqual(focused, target) else { throw fail("输入焦点与目标元素不一致，请重新获取快照") }
  }
  func focusedSafe(_ id: String, requireFocus: Bool = false) throws {
    let root = AXUIElementCreateApplication(try find(id).processIdentifier)
    guard let focused = attr(root, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() else {
      if requireFocus { throw fail("无法确认输入焦点，请重新获取快照并选择文本输入框") }; return
    }
    if secureContext(focused as! AXUIElement) { throw fail("不能向密码输入框注入输入") }
  }
  func guardInput(_ id: String) throws {
    try guardApp(id)
    guard watching, let tap, CGEvent.tapIsEnabled(tap: tap) else { throw fail("用户输入监听未启用，已拒绝桌面操作") }
  }
  func post(_ event: CGEvent?, _ id: String) throws {
    try guardInput(id)
    guard let event else { throw fail("无法创建输入事件") }
    if [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .scrollWheel].contains(event.type), owner(event.location)?.bundleIdentifier != id { throw fail("目标窗口已移动或被遮挡，请重新截图") }
    event.setIntegerValueField(.eventSourceUserData, value: marker)
    if [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp].contains(event.type) { mouseAnchor = event.location }
    event.post(tap: .cghidEventTap)
  }
  func release() {
    let source = CGEventSource(stateID: .hidSystemState)
    for key in heldKeys { let e = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false); e?.setIntegerValueField(.eventSourceUserData, value: marker); e?.post(tap: .cghidEventTap) }
    for raw in heldButtons { let button: CGMouseButton = raw == 1 ? .right : .left; let e = CGEvent(mouseEventSource: source, mouseType: raw == 1 ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: CGEvent(source: nil)?.location ?? .zero, mouseButton: button); e?.setIntegerValueField(.eventSourceUserData, value: marker); e?.post(tap: .cghidEventTap) }
    heldKeys.removeAll(); heldButtons.removeAll()
  }
  func watch(_ enabled: Bool) throws {
    if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
    if let tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, .commonModes) }
    tap = nil; tapSource = nil; mouseAnchor = nil; watching = false
    if !enabled { return }
    stopped = true
    if fake { watching = true; stopped = false; return }
    let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.mouseMoved.rawValue) | (1 << CGEventType.leftMouseDragged.rawValue) | (1 << CGEventType.rightMouseDragged.rawValue)
    // A default tap uses the Accessibility grant already required for desktop control.
    // Every callback branch returns the original event unchanged; user input is never swallowed.
    tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: CGEventMask(mask), callback: { _, type, event, context in
      guard let context else { return Unmanaged.passUnretained(event) }
      let helper = Unmanaged<Helper>.fromOpaque(context).takeUnretainedValue()
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        helper.stopped = true; helper.watching = false; helper.release()
        emit(["event": "user_input", "reason": type == .tapDisabledByTimeout ? "monitor_timeout" : "monitor_disabled"])
        return Unmanaged.passUnretained(event)
      }
      guard event.getIntegerValueField(.eventSourceUserData) != marker, !helper.stopped else { return Unmanaged.passUnretained(event) }
      var reason: String?
      if type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53 { reason = "escape" }
      if type == .mouseMoved || type == .leftMouseDragged || type == .rightMouseDragged {
        let anchor = helper.mouseAnchor ?? event.location; helper.mouseAnchor = anchor
        if hypot(event.location.x - anchor.x, event.location.y - anchor.y) > 20 { reason = "mouse" }
      }
      if let reason { helper.stopped = true; helper.release(); emit(["event": "user_input", "reason": reason]) }
      return Unmanaged.passUnretained(event)
    }, userInfo: Unmanaged.passUnretained(self).toOpaque())
    guard let tap else { throw fail("无法监听用户输入，请允许辅助功能权限后重试") }
    tapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    guard CGEvent.tapIsEnabled(tap: tap) else { try watch(false); throw fail("无法启用用户输入监听，已拒绝桌面操作") }
    watching = true; stopped = false
    mouseAnchor = CGEvent(source: nil)?.location
  }
  func execute(_ cmd: String, _ a: [String: Any]) async throws -> Any {
    if cmd == "release" { stopped = true; release(); try watch(false); refs.removeAll(); return NSNull() }
    if cmd == "watch_user_input" { try watch(a["enabled"] as? Bool ?? false); return NSNull() }
    if fake { return try await fakeExecute(cmd, a) }
    if cmd == "permissions" {
      if a["request"] as? String == "accessibility" { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
      if a["request"] as? String == "screenRecording" { _ = CGRequestScreenCaptureAccess() }
      return ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
    }
    if cmd == "apps" { return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map(appInfo) }
    if cmd == "resolve" {
      let query = a["app"] as? String ?? ""
      if let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == query || ($0.localizedName ?? "").caseInsensitiveCompare(query) == .orderedSame }) { return appInfo(app) }
      var url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query)
      if url == nil {
        for folder in ["/Applications", "/System/Applications", "/Applications/Utilities", "/System/Applications/Utilities"] {
          for candidate in (try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: folder), includingPropertiesForKeys: nil)) ?? [] {
            if candidate.pathExtension == "app" && candidate.deletingPathExtension().lastPathComponent.caseInsensitiveCompare(query) == .orderedSame { url = candidate; break }
          }
          if url != nil { break }
        }
      }
      guard let url, let bundle = Bundle(url: url), let bundleId = bundle.bundleIdentifier else { throw fail("没有找到 App：\(query)") }
      return ["bundleId": bundleId, "name": bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? url.deletingPathExtension().lastPathComponent, "pid": 0, "windows": []] as [String: Any]
    }
    if cmd == "frontmost" { guard let app = NSWorkspace.shared.frontmostApplication else { throw fail("没有前台 App") }; return appInfo(app) }
    if cmd == "window_at" { guard let x = a["x"] as? Double, let y = a["y"] as? Double else { throw fail("缺少坐标") }; if let owner = owner(CGPoint(x: x, y: y)) { return appInfo(owner) }; return NSNull() }
    guard let id = a["bundleId"] as? String else { throw fail("缺少 bundleId") }
    if cmd == "activate" {
      if stopped { throw fail("用户已停止桌面操作") }
      let app: NSRunningApplication
      if let running = try? find(id) { app = running }
      else {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { throw fail("找不到目标 App") }
        let config = NSWorkspace.OpenConfiguration(); config.activates = true
        app = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
      }
      guard app.activate(options: [.activateAllWindows]) else { throw fail("无法激活 App") }
      for _ in 0..<20 { if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == id { return appInfo(app) }; try await Task.sleep(nanoseconds: 50_000_000) }
      throw fail("App 未进入前台")
    }
    let app = try find(id)
    try guardApp(id)
    if cmd == "ax_tree" {
      refs.removeAll(); serial += 1
      let root = AXUIElementCreateApplication(app.processIdentifier)
      let deadline = Date().addingTimeInterval(5)
      var nodes: [[String: Any]] = []; var seen: [CFHashCode: [AXUIElement]] = [:]; var visited = 0
      func walk(_ n: AXUIElement, _ depth: Int, _ visibleDepth: Int) async throws {
        if stopped { throw fail("用户已停止桌面操作") }
        guard Date() < deadline else { throw fail("读取辅助功能树超时，请缩小操作范围后重试") }
        guard depth < 80, visited < 6000, nodes.count < 1500 else { return }
        let hash = CFHash(n)
        if seen[hash]?.contains(where: { CFEqual($0, n) }) == true { return }
        seen[hash, default: []].append(n); visited += 1
        if visited % 10 == 0 { try await Task.sleep(nanoseconds: 1_000_000) }
        let role = string(n, kAXRoleAttribute) ?? "AXUnknown"
        if role == "AXMenu", attr(n, kAXVisibleChildrenAttribute) as? [AXUIElement] == nil { return }
        let protected = secure(n)
        let title = protected ? "密码输入框" : string(n, kAXTitleAttribute) ?? string(n, kAXDescriptionAttribute)
        let value = protected ? nil : string(n, kAXValueAttribute)
        let placeholder = protected ? nil : string(n, "AXPlaceholderValue")
        let identifier = protected ? nil : string(n, "AXIdentifier")
        let focused = !protected && (attr(n, kAXFocusedAttribute) as? Bool == true)
        let emptyContainer = ["AXGroup", "AXUnknown", "AXLayoutArea", "AXScrollArea", "AXWebArea"].contains(role)
          && (title ?? "").isEmpty && (value ?? "").isEmpty && (placeholder ?? "").isEmpty && !focused
        if !emptyContainer {
          let key = "\(serial):\(nodes.count)"; refs[key] = (n, id, frame(n))
          var item: [String: Any] = ["id": key, "role": role, "enabled": protected ? false : (attr(n, kAXEnabledAttribute) as? Bool) ?? true, "depth": visibleDepth, "focused": focused]
          if let title { item["title"] = String(title.prefix(500)) }
          if let value { item["value"] = String(value.prefix(1500)) }
          if let placeholder { item["placeholder"] = String(placeholder.prefix(500)) }
          if let identifier { item["identifier"] = String(identifier.prefix(300)) }
          if let r = frame(n) { item["frame"] = rect(r) }; nodes.append(item)
        }
        if !protected {
          let children = role == "AXMenu" ? attr(n, kAXVisibleChildrenAttribute) as? [AXUIElement] ?? [] : attr(n, kAXChildrenAttribute) as? [AXUIElement] ?? []
          for child in children { try await walk(child, depth + 1, emptyContainer ? visibleDepth : visibleDepth + 1) }
        }
      }
      let targetWindow = selectedWindow(app)
      // Surface focus only when it belongs to the selected main window, not a floating preview.
      if let focused = attr(root, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(), !secureContext(focused as! AXUIElement) {
        let focusedWindow = attr(focused as! AXUIElement, kAXWindowAttribute)
        if targetWindow == nil || (focusedWindow != nil && CFEqual(focusedWindow!, targetWindow!)) {
          try await walk(focused as! AXUIElement, 0, 0)
        }
      }
      try await walk(targetWindow ?? root, 0, 0)
      if let menu = attr(root, kAXMenuBarAttribute), CFGetTypeID(menu) == AXUIElementGetTypeID() { try await walk(menu as! AXUIElement, 0, 0) }
      nodes = nodes.enumerated().sorted { a, b in
        func rank(_ item: [String: Any]) -> Int {
          if item["focused"] as? Bool == true { return 0 }
          if ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"].contains(item["role"] as? String ?? "") { return 1 }
          return 2
        }
        let ar = rank(a.element), br = rank(b.element)
        return ar == br ? a.offset < b.offset : ar < br
      }.map { $0.element }
      try guardApp(id); return ["app": appInfo(app), "nodes": nodes]
    }
    if cmd == "screenshot" {
      guard CGPreflightScreenCaptureAccess() else { throw fail("需要在系统设置中允许屏幕录制权限") }
      let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      let candidates = content.windows.filter { $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer == 0 && $0.frame.width > 1 && $0.frame.height > 1 }
      let target = selectedWindow(app)
      let bounds = target.flatMap { frame($0) }
      if target != nil && bounds == nil { throw fail("无法确定当前窗口位置，请重新获取快照") }
      guard let index = selectedScreenshotIndex(candidates.map { ($0.frame, $0.title) }, bounds: bounds, title: target.flatMap { string($0, kAXTitleAttribute) }) else {
        throw fail("无法唯一匹配当前应用窗口，请聚焦目标窗口后重试")
      }
      let w = candidates[index]
      let ratio = min(1, 1568 / max(w.frame.width, w.frame.height)); let config = SCStreamConfiguration()
      config.width = max(1, Int(w.frame.width * ratio)); config.height = max(1, Int(w.frame.height * ratio)); config.showsCursor = false
      config.ignoreShadowsSingleWindow = true
      let cg = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: w), configuration: config)
      try guardApp(id)
      if let target { guard let current = selectedWindow(app), CFEqual(current, target) else { throw fail("截图期间焦点窗口已改变，请重新截图") } }
      guard let latest = windows().first(where: { ($0[kCGWindowNumber as String] as? UInt32) == w.windowID }),
            let rawBounds = latest[kCGWindowBounds as String] as? NSDictionary,
            let currentBounds = CGRect(dictionaryRepresentation: rawBounds), currentBounds == w.frame else { throw fail("截图期间窗口位置已改变，请重新截图") }
      guard let data = NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { throw fail("截图编码失败") }
      return ["data": data.base64EncodedString(), "width": cg.width, "height": cg.height, "bounds": rect(w.frame)]
    }
    try guardInput(id)
    let n = try node(a, id)
    if cmd == "click" {
      if let n, a["x"] == nil, a["y"] == nil, a["button"] as? String != "right", a["double"] as? Bool != true {
        var actions: CFArray?
        if AXUIElementCopyActionNames(n, &actions) == .success, (actions as? [String] ?? []).contains(kAXPressAction) {
          _ = try node(a, id)
          try await Task.sleep(nanoseconds: 1_000_000)
          try guardInput(id)
          guard AXUIElementPerformAction(n, kAXPressAction as CFString) == .success else { throw fail("无法点击该元素，请重新获取快照") }
          return NSNull()
        }
      }
      let p = try position(a, n, id); let right = a["button"] as? String == "right"; let count = (a["double"] as? Bool ?? false) ? 2 : 1
      for index in 1...count {
        try guardApp(id); guard owner(p)?.bundleIdentifier == id else { throw fail("目标窗口已移动") }
        try await Task.sleep(nanoseconds: 1_000_000)
        let down = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: p, mouseButton: right ? .right : .left)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(index)); heldButtons.insert(right ? 1 : 0); try post(down, id)
        let up = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: p, mouseButton: right ? .right : .left); up?.setIntegerValueField(.mouseEventClickState, value: Int64(index)); try post(up, id); heldButtons.remove(right ? 1 : 0)
        await Task.yield()
      }
      return NSNull()
    }
    if cmd == "type" {
      if let n { guard AXUIElementSetAttributeValue(n, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { throw fail("无法聚焦该元素") } }
      try await Task.sleep(nanoseconds: 1_000_000)
      if let n { try verifyFocus(n, id) }
      try focusedSafe(id, requireFocus: true)
      let text = a["text"] as? String ?? ""
      for units in unicodeChunks(text) {
        try guardInput(id); try focusedSafe(id, requireFocus: true)
        if let n { try verifyFocus(n, id) }
        // Let the event tap process user input received during synchronous AX calls before posting.
        try await Task.sleep(nanoseconds: 1_000_000)
        if let n { try verifyFocus(n, id) }
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true); down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units); heldKeys.insert(0); try post(down, id)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false); up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units); try post(up, id); heldKeys.remove(0)
        try await Task.sleep(nanoseconds: 1_000_000)
      }
      return NSNull()
    }
    if cmd == "key" {
      try focusedSafe(id)
      let parts = (a["combo"] as? String ?? "").lowercased().split(separator: "+").map(String.init)
      let codes: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"enter":36,"return":36,"l":37,"j":38,"k":40,"n":45,"m":46,"tab":48,"space":49,"backspace":51,"delete":51,"escape":53,"esc":53,"home":115,"pageup":116,"forwarddelete":117,"end":119,"pagedown":121,"left":123,"right":124,"down":125,"up":126]
      guard let last = parts.last, let code = codes[last] else { throw fail("不支持的按键组合") }
      var flags: CGEventFlags = []
      for modifier in parts.dropLast() { switch modifier { case "cmd", "command", "meta": flags.insert(.maskCommand); case "ctrl", "control": flags.insert(.maskControl); case "alt", "option": flags.insert(.maskAlternate); case "shift": flags.insert(.maskShift); default: throw fail("不支持的修饰键：\(modifier)") } }
      try await Task.sleep(nanoseconds: 1_000_000)
      heldKeys.insert(code)
      let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true); down?.flags = flags; try post(down, id)
      let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false); try post(up, id); heldKeys.remove(code); return NSNull()
    }
    if cmd == "scroll" {
      let p = try position(a, n, id)
      try await Task.sleep(nanoseconds: 1_000_000)
      try post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left), id)
      let dx = max(-10000, min(10000, a["dx"] as? Int ?? 0)), dy = max(-10000, min(10000, a["dy"] as? Int ?? 0))
      let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0)
      event?.location = p
      try post(event, id); return NSNull()
    }
    throw fail("未知命令：\(cmd)")
  }
  func fakeExecute(_ cmd: String, _ a: [String: Any]) async throws -> Any {
    if ["activate", "click", "type", "key", "scroll"].contains(cmd) {
      guard !stopped, watching else { throw fail("用户已停止桌面操作或用户输入监听未启用") }
      if let ref = a["ref"] as? String, ref != fakeRef { throw fail("元素引用已失效，请重新获取快照") }
    }
    switch cmd {
    case "permissions": return ["accessibility": true, "screenRecording": true]
    case "apps": return [fakeApp]
    case "resolve", "frontmost", "activate", "window_at": return fakeApp
    case "ax_tree":
      serial += 1; fakeRef = "fake:\(serial)"
      return ["app": fakeApp, "nodes": [["id": fakeRef, "role": "AXTextArea", "title": "Document", "value": fakeText, "enabled": true, "depth": 0, "frame": ["x": 100, "y": 100, "width": 600, "height": 400]]]]
    case "screenshot":
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 600, pixelsHigh: 400, bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
      memset(bitmap.bitmapData!, 245, bitmap.bytesPerRow * bitmap.pixelsHigh)
      return ["data": bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.8])!.base64EncodedString(), "width": 600, "height": 400, "bounds": ["x":100,"y":100,"width":600,"height":400]]
    case "type":
      for character in a["text"] as? String ?? "" {
        try await Task.sleep(nanoseconds: 1_000_000)
        guard !stopped, watching else { throw fail("用户已停止桌面操作") }
        fakeText.append(character)
      }
      return NSNull()
    case "click", "key", "scroll": return NSNull()
    default: throw fail("未知命令：\(cmd)")
    }
  }
}
let helper = Helper()
// Bound unresponsive apps globally; AX timeouts set on a root do not apply to its children.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.15)
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler { helper.stopped = true; helper.release(); try? helper.watch(false); exit(0) }
termination.resume()
let interruption = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interruption.setEventHandler { helper.stopped = true; helper.release(); try? helper.watch(false); exit(0) }
interruption.resume()
var pendingCommand: Task<Void, Never>?
var commandGeneration = 0
DispatchQueue.global().async {
  while let line = readLine() {
    DispatchQueue.main.async {
      let request = line.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      let cmd = request?["cmd"] as? String
      let args = request?["args"] as? [String: Any] ?? [:]
      let urgent = cmd == "release" || (cmd == "watch_user_input" && args["enabled"] as? Bool == false)
      if urgent { commandGeneration += 1; helper.stopped = true; helper.release() }
      let generation = commandGeneration
      let previous = pendingCommand
      let task = Task { @MainActor in
        if !urgent { await previous?.value }
        let id = request?["id"] ?? NSNull()
        do {
          guard let cmd else { throw fail("无效的 JSON 命令") }
          if !urgent, generation != commandGeneration { throw fail("用户已停止桌面操作，已取消排队命令") }
          let result = try await helper.execute(cmd, args); emit(["id": id, "ok": true, "result": result])
        } catch { helper.release(); emit(["id": id, "ok": false, "error": error.localizedDescription]) }
      }
      if !urgent { pendingCommand = task }
    }
  }
  DispatchQueue.main.async {
    let pending = pendingCommand
    Task { @MainActor in
      await pending?.value
      helper.release(); try? helper.watch(false); exit(0)
    }
  }
}
RunLoop.main.run()
