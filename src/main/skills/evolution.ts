import type { Memory, SkillEvolved, SkillProposal, SkillStats } from '@shared/types'
import { db } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { getSettings } from '../core/settings'
import type { LearnTurn } from '../learning/scheduler'
import { hostOf, similarity } from '../memory/recall'
import { createChatModel, models } from '../models/registry'
import {
  applyPatch,
  classify,
  parseReflection,
  reflectionMessages,
  shouldSuggestRollback,
  skillsUsed,
  slugify,
  worthReflecting,
  type Gate,
  type Reflection,
  type SkillPatch,
} from './evolution-core'
import { parseFrontmatter } from './frontmatter'
import { skills } from './skill-service'
import { skillVersions } from './versions'

interface ProposalRow {
  id: string
  skill: string
  kind: SkillProposal['kind']
  content: string
  base_version: number | null
  reason: string | null
  evidence: string | null
  thread_id: string | null
  status: string
  at: number
}

/** A site with at least this many remembered tips gets a skill of its own. */
const SITE_SKILL_MIN_NOTES = 3

const hostsIn = (turns: LearnTurn[]) =>
  [...new Set(turns.flatMap((t) => t.actions).flatMap((a) => (/https?:\/\/\S+/.exec(a)?.[0] ? [hostOf(/https?:\/\/\S+/.exec(a)![0])] : [])))].filter(
    (h): h is string => !!h,
  )

/** Local name a shared skill gets when an improved copy of it is saved. */
function localNameFor(id: string): string {
  if (!id.startsWith('ext:')) return id
  const fm = parseFrontmatter(skills.read(id))
  return slugify(fm.name || id.split('/').pop() || 'skill')
}

/** Makes sure the frontmatter `name` is the skill's directory name (what skills.save requires). */
function withName(content: string, name: string): string {
  const fm = parseFrontmatter(content)
  if (fm.name === name) return content
  return fm.name ? content.replace(/^(---\r?\n[\s\S]*?^name:\s*).*$/m, `$1${name}`) : content
}

class SkillEvolution {
  private busy = new Set<string>()

  // ---------- looking back at a stretch of conversation

  /**
   * Called by the learning scheduler with the turns it is processing: records which skills were
   * used and, when it is worth a model call, asks the coach whether a skill should change or a new
   * one be distilled.
   */
  async reflect(threadId: string, turns: LearnTurn[], modelId: string | null): Promise<void> {
    const cfg = getSettings().skills
    const used = skillsUsed(turns.flatMap((t) => t.filesRead)).filter((id) => skills.exists(id))
    if (!cfg.selfImprove) return this.recordRuns(used, threadId, 'unknown')
    if (!worthReflecting(turns, used) || this.busy.has(threadId)) return this.recordRuns(used, threadId, 'unknown')
    this.busy.add(threadId)
    try {
      const mem = getSettings().memory
      const model = mem.modelId && models.get(mem.modelId) ? mem.modelId : modelId
      const res = await createChatModel(model).invoke(
        reflectionMessages(
          used.map((id) => ({ id, content: skills.read(id) })),
          turns,
        ),
      )
      const text = typeof res.content === 'string' ? res.content : (res.content as { text?: string }[]).map((b) => b.text ?? '').join('')
      const r = parseReflection(text)
      this.recordRuns(used, threadId, r.outcome ?? 'ok', r.reason ?? undefined)
      this.apply(r, { threadId, used, hosts: hostsIn(turns) })
      for (const id of used) this.maybeSuggestRollback(id)
    } catch (err) {
      log.warn(`[skills] reflection failed: ${(err as Error).message}`)
    } finally {
      this.busy.delete(threadId)
    }
  }

  private recordRuns(used: string[], threadId: string, outcome: string, note?: string): void {
    const st = db().prepare('INSERT INTO skill_runs(id, skill, version, thread_id, at, outcome, note) VALUES(?, ?, ?, ?, ?, ?, ?)')
    for (const id of used) st.run(newId(), id, skillVersions.latest(id)?.version ?? null, threadId, Date.now(), outcome, note ?? null)
  }

  /** Routes the coach's decision through the gate: apply, propose, or drop. */
  apply(r: Reflection, ctx: { threadId: string | null; used: string[]; hosts: string[] }): SkillEvolved | null {
    if (r.action === 'none') return null
    const cfg = getSettings().skills
    const reason = r.reason ?? ''
    const evidence = r.evidence ?? ''
    try {
      if (r.action === 'create') {
        const name = slugify(r.name || parseFrontmatter(r.content ?? '').name || '')
        if (!name || skills.exists(name)) return null
        const content = withName(r.content!, name)
        // the same way of working was already proposed from another conversation: it has proved itself
        const earlier = this.pending().find(
          (p) =>
            p.kind === 'create' &&
            p.threadId !== ctx.threadId &&
            (p.skill === name ||
              similarity(
                { title: p.skill, content: parseFrontmatter(p.content).description ?? '' },
                { title: name, content: parseFrontmatter(content).description ?? '' },
              ) >= 0.5),
        )
        const gate = classify({
          kind: 'create',
          readOnly: false,
          before: '',
          after: content,
          hostsVisited: ctx.hosts,
          autoApplySmall: cfg.autoApplySmall,
          provenBefore: !!earlier,
          autoCreateFromExperience: cfg.autoCreateFromExperience,
        })
        if (gate.decision === 'auto') {
          skills.save(name, content, { source: 'experience', reason: reason || '同类任务已经顺利完成多次', threadId: ctx.threadId })
          if (earlier) db().prepare("UPDATE skill_proposals SET status = 'superseded' WHERE id = ?").run(earlier.id)
          return this.announce({
            skill: name,
            kind: 'created',
            summary: reason || '把多次用过的做法整理成了 Skill',
            version: skillVersions.latest(name)?.version,
          })
        }
        return this.gateResult(gate, { skill: name, kind: 'create', content, reason, evidence, threadId: ctx.threadId })
      }

      // patch / rewrite target one of the skills that were used
      const id = r.skill && ctx.used.includes(r.skill) ? r.skill : ctx.used.length === 1 ? ctx.used[0] : null
      if (!id) return null
      const readOnly = id.startsWith('ext:')
      const before = skills.read(id)
      const name = localNameFor(id)
      const after =
        r.action === 'rewrite'
          ? withName(r.content!, name)
          : withName(applyPatch(before, { add_notes: r.add_notes ?? undefined, replace: r.replace ?? undefined }), name)
      if (after === before) return null
      const gate = classify({ kind: r.action, readOnly, before, after, hostsVisited: ctx.hosts, autoApplySmall: cfg.autoApplySmall })
      if (gate.decision === 'auto') {
        skills.save(id, after, { source: 'agent-patch', reason, threadId: ctx.threadId })
        return this.announce({ skill: id, kind: 'patched', summary: reason || '补充了经验', version: skillVersions.latest(id)?.version })
      }
      return this.gateResult(gate, { skill: name, kind: readOnly ? 'fork' : r.action, content: after, reason, evidence, threadId: ctx.threadId })
    } catch (err) {
      log.info(`[skills] change not applied: ${(err as Error).message}`)
      return null
    }
  }

  private gateResult(
    gate: Gate,
    p: { skill: string; kind: SkillProposal['kind']; content: string; reason: string; evidence: string; threadId: string | null },
  ): SkillEvolved | null {
    if (gate.decision === 'reject') {
      log.info(`[skills] change to "${p.skill}" dropped: ${gate.why}`)
      return null
    }
    // one open proposal per skill and kind: the newer one replaces it
    db()
      .prepare("UPDATE skill_proposals SET status = 'superseded' WHERE skill = ? AND kind = ? AND status = 'pending' AND (thread_id IS ? OR kind != 'create')")
      .run(p.skill, p.kind, p.threadId)
    const id = newId()
    db()
      .prepare('INSERT INTO skill_proposals(id, skill, kind, content, base_version, reason, evidence, thread_id, at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        p.skill,
        p.kind,
        p.content,
        skillVersions.latest(p.skill)?.version ?? null,
        p.reason || (gate.decision === 'confirm' ? gate.why : ''),
        p.evidence,
        p.threadId,
        Date.now(),
      )
    return this.announce({ skill: p.skill, kind: 'proposed', summary: p.reason || (gate.decision === 'confirm' ? gate.why : ''), proposalId: id })
  }

  private announce(e: SkillEvolved): SkillEvolved {
    emit('skills.evolved', e)
    return e
  }

  /** The agent's own note about a skill during a run (the `skill_note` tool). */
  note(skillId: string, patch: SkillPatch, reason: string, ctx: { threadId: string | null; hosts: string[] }): string {
    if (!skills.exists(skillId)) throw new Error(`Skill 不存在: ${skillId}`)
    const r = this.apply(
      { action: 'patch', skill: skillId, add_notes: patch.add_notes, replace: patch.replace, reason },
      { threadId: ctx.threadId, used: [skillId], hosts: ctx.hosts },
    )
    if (!r) return '没有改动（内容已存在、无法定位要替换的原文，或未通过安全检查）'
    return r.kind === 'patched' ? `已更新 Skill（版本 ${r.version}）` : '改动较大或涉及共享 Skill，已生成改进建议，等用户在「Skill」页确认'
  }

  /** A new skill or a full rewrite the agent wants to save without the user having asked: a proposal. */
  propose(name: string, content: string, reason: string, threadId: string | null): SkillEvolved | null {
    const exists = skills.exists(name)
    return this.gateResult(
      classify({
        kind: exists ? 'rewrite' : 'create',
        readOnly: false,
        before: exists ? skills.read(name) : '',
        after: content,
        hostsVisited: [],
        autoApplySmall: false,
      }),
      { skill: name, kind: exists ? 'rewrite' : 'create', content, reason, evidence: '', threadId },
    )
  }

  // ---------- proposals

  private pending(): SkillProposal[] {
    const rows = db().prepare("SELECT * FROM skill_proposals WHERE status = 'pending' ORDER BY at DESC").all() as ProposalRow[]
    return rows.map((r) => ({
      id: r.id,
      skill: r.skill,
      kind: r.kind,
      content: r.content,
      before: skills.exists(r.skill) ? skills.read(r.skill) : '',
      reason: r.reason ?? '',
      evidence: r.evidence ?? '',
      threadId: r.thread_id,
      at: r.at,
    }))
  }

  proposals(): SkillProposal[] {
    return this.pending()
  }

  /** The user's decision; `content` lets them edit the text before approving. */
  resolveProposal(id: string, approve: boolean, content?: string): void {
    const p = this.pending().find((x) => x.id === id)
    if (!p) throw new Error('这条建议已经处理过了')
    if (approve) {
      skills.save(p.skill, withName(content ?? p.content, p.skill), {
        source: p.kind === 'rollback' ? 'rollback' : 'agent-proposal',
        reason: p.reason,
        threadId: p.threadId,
      })
    }
    db()
      .prepare('UPDATE skill_proposals SET status = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', id)
    emit('skills.changed')
  }

  // ---------- how well skills are doing

  stats(): Record<string, SkillStats> {
    const out: Record<string, SkillStats> = {}
    const blank = (): SkillStats => ({ uses: 0, ok: 0, corrected: 0, failed: 0, version: 0, autoPatches: 0 })
    for (const r of db().prepare('SELECT skill, outcome, COUNT(*) AS n FROM skill_runs GROUP BY skill, outcome').all() as {
      skill: string
      outcome: string
      n: number
    }[]) {
      const s = (out[r.skill] ??= blank())
      s.uses += r.n
      if (r.outcome === 'ok') s.ok += r.n
      else if (r.outcome === 'corrected') s.corrected += r.n
      else if (r.outcome === 'failed') s.failed += r.n
    }
    for (const r of db()
      .prepare("SELECT skill, MAX(version) AS v, SUM(source IN ('agent-patch', 'experience')) AS a FROM skill_versions GROUP BY skill")
      .all() as {
      skill: string
      v: number
      a: number
    }[]) {
      const s = (out[r.skill] ??= blank())
      s.version = r.v
      s.autoPatches = r.a
    }
    return out
  }

  /** An automatic patch whose first uses went worse than before: propose going back. */
  private maybeSuggestRollback(skill: string): void {
    const versions = skillVersions.history(skill).reverse()
    if (versions.length < 2) return
    const runs = db().prepare('SELECT version, outcome, COUNT(*) AS n FROM skill_runs WHERE skill = ? GROUP BY version, outcome').all(skill) as {
      version: number | null
      outcome: string
      n: number
    }[]
    const count = (v: number, bad: boolean) =>
      runs
        .filter((r) => r.version === v && (r.outcome === 'corrected' || r.outcome === 'failed') === bad && r.outcome !== 'unknown')
        .reduce((n, r) => n + r.n, 0)
    const stat = versions.map((v) => ({ version: v.version, source: v.source, ok: count(v.version, false), bad: count(v.version, true) }))
    if (!shouldSuggestRollback(stat)) return
    const prev = versions[versions.length - 2]
    this.gateResult(
      { decision: 'confirm', why: '' },
      { skill, kind: 'rollback', content: prev.content, reason: `最近一次自动改进后效果变差，建议回到版本 ${prev.version}`, evidence: '', threadId: null },
    )
  }

  // ---------- experience → skills

  /**
   * Tips remembered for a website become a skill once there are enough of them, and the skill follows
   * the tips as they change — unless the user has edited it by hand since.
   */
  syncSiteSkills(memories: Memory[]): void {
    if (!getSettings().skills.selfImprove || !getSettings().skills.autoCreateFromExperience) return
    const bySite = new Map<string, Memory[]>()
    for (const m of memories) if (m.kind === 'site' && m.status === 'active' && m.scope) bySite.set(m.scope, [...(bySite.get(m.scope) ?? []), m])
    for (const [host, notes] of bySite) {
      if (notes.length < SITE_SKILL_MIN_NOTES) continue
      const name = `site-${slugify(host)}`
      const content = siteSkill(name, host, notes)
      const latest = skillVersions.latest(name)
      try {
        if (!skills.exists(name)) {
          // deleted by the user before: don't bring it back
          if (latest) continue
          skills.save(name, content, { source: 'experience', reason: `由 ${notes.length} 条 ${host} 的站点经验整理而成` })
          this.announce({ skill: name, kind: 'created', summary: `把 ${host} 的 ${notes.length} 条经验整理成了 Skill`, version: 1 })
        } else if (latest?.source === 'experience' && latest.content !== content) {
          skills.save(name, content, { source: 'experience', reason: `${host} 的站点经验有更新` })
        }
      } catch (err) {
        log.info(`[skills] site skill for ${host} not written: ${(err as Error).message}`)
      }
    }
  }

  /** Development / evaluation: the coach's decision for a stretch, and what the gate would do with it. */
  async dryRun(used: { id: string; content: string }[], turns: LearnTurn[], modelId: string | null = null) {
    const res = await createChatModel(modelId).invoke(reflectionMessages(used, turns))
    const raw = typeof res.content === 'string' ? res.content : (res.content as { text?: string }[]).map((b) => b.text ?? '').join('')
    const r = parseReflection(raw)
    let gate: Gate | null = null
    let after: string | null = null
    try {
      if (r.action === 'create') {
        after = withName(r.content!, slugify(r.name || parseFrontmatter(r.content ?? '').name || 'new-skill'))
        gate = classify({ kind: 'create', readOnly: false, before: '', after, hostsVisited: hostsIn(turns), autoApplySmall: true })
      } else if (r.action !== 'none') {
        const target = used.find((s) => s.id === r.skill) ?? used[0]
        if (target) {
          after = r.action === 'rewrite' ? r.content! : applyPatch(target.content, { add_notes: r.add_notes ?? undefined, replace: r.replace ?? undefined })
          gate = classify({
            kind: r.action,
            readOnly: target.id.startsWith('ext:'),
            before: target.content,
            after,
            hostsVisited: hostsIn(turns),
            autoApplySmall: true,
          })
        }
      }
    } catch (err) {
      gate = { decision: 'reject', why: (err as Error).message }
    }
    return { raw, reflection: r, gate, after }
  }
}

function siteSkill(name: string, host: string, notes: Memory[]): string {
  const sorted = [...notes].sort((a, b) => a.createdAt - b.createdAt)
  return `---
name: ${name}
description: 在 ${host} 上操作时的经验和注意事项（由 Navo 根据积累的站点经验自动整理）
---

# ${host} 操作经验

在 ${host}（含子域名）的页面上操作时先看这里，这些是之前实际操作中总结出来的：

${sorted.map((m) => `- **${m.title}**：${m.content}`).join('\n')}
`
}

export const skillEvolution = new SkillEvolution()
