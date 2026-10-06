import { useEffect, useState } from 'react'
import type { SkillProposal, SkillStats } from '@shared/types'
import { call, on } from '@/lib/ipc'

/** Suggestions waiting for the user and per-skill usage; `onChange` fires when a skill changed by itself. */
export function useSkillEvolution(onChange: () => void) {
  const [proposals, setProposals] = useState<SkillProposal[]>([])
  const [stats, setStats] = useState<Record<string, SkillStats>>({})
  useEffect(() => {
    const load = () => {
      void call('skills.proposals').then(setProposals, () => setProposals([]))
      void call('skills.stats').then(setStats, () => setStats({}))
    }
    load()
    const offs = [
      on('skills.evolved', () => {
        load()
        onChange()
      }),
      on('skills.changed', () => {
        load()
        onChange()
      }),
    ]
    return () => offs.forEach((off) => off())
    // onChange is a stable reload callback from the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { proposals, stats }
}
