import { app } from 'electron'
import { join } from 'node:path'

/**
 * Paths inside the built app. Bundled ESM has no reliable __dirname (code may live in a shared
 * chunk), so everything is resolved from the app root: the project dir in dev, app.asar when packaged.
 */
export const appFile = (...p: string[]) => join(app.getAppPath(), ...p)
