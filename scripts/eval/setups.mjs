/**
 * Per-task workspace mutations before the agent runs.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import path from 'path'
import { FABRIC_VERSIONS } from '../fabric-template.mjs'

function javaRoot(projectDir) {
  return path.join(projectDir, 'src/main/java/com/example/eval_mod')
}

export const setups = {
  ensureCopperCoinStub(projectDir) {
    const items = path.join(javaRoot(projectDir), 'ModItems.java')
    let src = readFileSync(items, 'utf-8')
    if (!src.includes('copper_coin')) {
      src = src.replace(
        'public static final Item TEST_ITEM = register("test_item", new Item.Settings());',
        'public static final Item TEST_ITEM = register("test_item", new Item.Settings());\n    public static final Item COPPER_COIN = register("copper_coin", new Item.Settings());'
      )
      writeFileSync(items, src, 'utf-8')
    }
    const modelDir = path.join(projectDir, 'src/main/resources/assets/evalmod/models/item')
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(
      path.join(modelDir, 'copper_coin.json'),
      JSON.stringify({ parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/copper_ingot' } }, null, 2),
      'utf-8'
    )
    const lang = path.join(projectDir, 'src/main/resources/assets/evalmod/lang/en_us.json')
    const langObj = existsSync(lang) ? JSON.parse(readFileSync(lang, 'utf-8')) : {}
    langObj['item.evalmod.copper_coin'] = 'Copper Coin'
    writeFileSync(lang, JSON.stringify(langObj, null, 2), 'utf-8')
  },

  ensureMixinsJson(projectDir) {
    const p = path.join(projectDir, 'src/main/resources/evalmod.mixins.json')
    if (!existsSync(p)) {
      writeFileSync(
        p,
        JSON.stringify({
          required: true,
          package: 'com.example.eval_mod.mixin',
          mixins: [],
          client: [],
          injectors: { defaultRequire: 1 }
        }, null, 2),
        'utf-8'
      )
    }
    mkdirSync(path.join(javaRoot(projectDir), 'mixin'), { recursive: true })
  },

  injectCompileError(projectDir) {
    const file = path.join(javaRoot(projectDir), 'BrokenHelper.java')
    writeFileSync(
      file,
      `package com.example.eval_mod;

/** Intentionally broken for T04 eval */
public class BrokenHelper {
    public static void boom() {
        MissingClassThatDoesNotExist x = null;
        System.out.println(x);
    }
}
`,
      'utf-8'
    )
    const main = path.join(javaRoot(projectDir), 'EvalMod.java')
    let src = readFileSync(main, 'utf-8')
    if (!src.includes('BrokenHelper')) {
      src = src.replace(
        'ModItems.registerModItems();',
        'ModItems.registerModItems();\n        BrokenHelper.boom();'
      )
      writeFileSync(main, src, 'utf-8')
    }
  },

  injectBadFabricVersion(projectDir) {
    const props = path.join(projectDir, 'gradle.properties')
    let text = readFileSync(props, 'utf-8')
    text = text.replace(
      /fabric_version=.*/,
      'fabric_version=99.0.0+broken'
    )
    writeFileSync(props, text, 'utf-8')
  },

  breakFabricModJson(projectDir) {
    const p = path.join(projectDir, 'src/main/resources/fabric.mod.json')
    // Intentionally incomplete metadata for T10
    writeFileSync(
      p,
      JSON.stringify({
        schemaVersion: 1,
        id: 'evalmod',
        version: '${version}'
      }, null, 2),
      'utf-8'
    )
  }
}

export function applySetups(projectDir, names = []) {
  for (const name of names) {
    const fn = setups[name]
    if (!fn) throw new Error(`Unknown setup: ${name}`)
    fn(projectDir)
  }
}

void FABRIC_VERSIONS
