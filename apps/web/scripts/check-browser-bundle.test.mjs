import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findForbiddenBrowserImport } from './check-browser-bundle.mjs'

describe('findForbiddenBrowserImport', () => {
  it('rejects Electron and Node imports', () => {
    assert.equal(findForbiddenBrowserImport('import { app } from "electron"'), 'from "electron"')
    assert.equal(findForbiddenBrowserImport("import fs from 'node:fs'"), "from 'node:fs'")
    assert.equal(findForbiddenBrowserImport('const fs = require("fs")'), 'require("fs")')
    assert.equal(findForbiddenBrowserImport("import Store from 'electron-store'"), "from 'electron-store'")
  })

  it('allows browser-safe modules and relative paths', () => {
    assert.equal(findForbiddenBrowserImport('import { useState } from "react"'), null)
    assert.equal(findForbiddenBrowserImport('import { join } from "./path"'), null)
    assert.equal(findForbiddenBrowserImport('export function hasElectronBridge() {}'), null)
  })
})
