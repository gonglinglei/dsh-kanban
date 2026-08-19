/**
 * Plugin config, validated by the same-named schemastery schema. Every
 * deployment-varying choice is a cordis.yml field — no hardcoded tunables.
 */
import { join } from 'node:path'
import z from 'schemastery'
import { dshHome } from './dsh-home.ts'

export interface Config {
  /** Master switch for the plugin (host announcement + routes). */
  enabled?: boolean
  /** When true (default), a system-prompt section announces the board to every agent. */
  announceToAgent?: boolean
  /**
   * Park designing/executing projects into blocked after this many minutes
   * without activity; 0 disables the stale timer (default).
   */
  maxStaleMinutes?: number
  /** Ledger file override; default is `<dsh home>/kanban/projects.json`. */
  projectsFile?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  maxStaleMinutes: z.number().min(0).default(0),
  projectsFile: z.string(),
})

/** Resolve the ledger file: explicit override, else the DSH-home default. */
export function resolveProjectsFile(configured: string | undefined, home: string = dshHome()): string {
  if (configured === undefined || configured.trim() === '') return join(home, 'kanban', 'projects.json')
  const expanded = configured === '~' ? home : configured.startsWith('~/') ? join(home, configured.slice(2)) : configured
  return expanded
}
