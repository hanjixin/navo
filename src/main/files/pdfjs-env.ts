// pdf.js decides once, at load time, whether it runs in Node. It treats any Electron process whose
// `process.type` isn't "browser" as a web page and then reaches for `document` (canvas, fonts, image
// decoding). The parser is a utilityProcess, so it presents itself as Node while pdf.js loads;
// pdf.ts restores the real value right after.
export const realProcessType = (process as { type?: string }).type
if (realProcessType && realProcessType !== 'browser') Object.defineProperty(process, 'type', { value: 'browser', configurable: true, writable: true })
