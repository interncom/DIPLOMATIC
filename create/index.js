#!/usr/bin/env node

import prompts from "prompts"
import { reset } from "kolorist"

const result = await prompts([
  {
    type: 'text',
    name: 'appName',
    message: reset('App name:'),
    validate: name => {
      if (!/^[a-zA-Z0-9-_]+$/.test(name)) {
        return 'Only use alphanumeric chars with dashes and underscores'
      }
      return true
    },
  },
  {
    type: 'select',
    name: 'appType',
    message: reset('App type:'),
    choices: [
      { title: 'React Web App w/ Vite', value: 'react-web-app' },
    ],
  },
  {
    type: 'text',
    name: 'hostURL',
    message: reset('Host URL:'),
    initial: 'https://diplomatic-cloudflare-host.root-a00.workers.dev',
  },
])

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sourceDir = path.join(__dirname, './templates/react-web')
const targetDir = result.appName

async function editJsonFile(filePath, modifyCallback) {
  try {
    const fileContent = await fs.readFile(filePath, 'utf8')
    const jsonData = JSON.parse(fileContent)
    const modifiedData = modifyCallback(jsonData)
    await fs.writeFile(filePath, JSON.stringify(modifiedData, null, 2), 'utf8')
  } catch (error) {
    console.error('Error modifying JSON file:', error)
  }
}

await fs.cp(sourceDir, targetDir, { recursive: true })
await editJsonFile(path.join(targetDir, 'package.json'), (pkg) => {
  pkg.name = result.appName
  return pkg
})
await editJsonFile(path.join(targetDir, 'src', 'consts.json'), (consts) => {
  consts.hostURL = result.hostURL
  return consts
})
