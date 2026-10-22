/**
 * 防回归：persona 标量里的提示词变量闸门自检。
 *
 * 背景：dsh-purge 1.1.71 的 cordis.patch.yml 把 personaSuffix 写成
 * `Your working directory is {{cwd}}.`；DSH 0.2.1 只注册 provider / model，
 * renderPrompt 抛 unknown prompt variable，整轮失败。
 *
 * 跑法：node scripts/verify-prompt-vars.mjs
 * 退出码 0 = 通过；1 = 有回归。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_REGISTERED_PROMPT_VARS,
  checkPluginCordisPatch,
  findPromptVariables,
  findUnregisteredPromptVariables,
  guardPersonaScalarsInYaml,
  neutralizePromptVariables,
  pluginCordisPatchPath,
} from "../lib/prompt-vars.js";
import { overlayOfficialIdentity } from "../lib/identity.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push({ name, message: String(err?.message || err) });
    console.log(`FAIL ${name}: ${err?.message || err}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

check("宿主变量表只含 provider/model", () => {
  const names = [...HOST_REGISTERED_PROMPT_VARS].sort();
  assert(names.join(",") === "model,provider", `实际: ${names.join(",")}`);
});

check("能扫出 {{cwd}}", () => {
  const hits = findPromptVariables("Your working directory is {{cwd}}.");
  assert(hits.length === 1 && hits[0].name === "cwd", JSON.stringify(hits));
});

check("未注册变量被识别", () => {
  const bad = findUnregisteredPromptVariables("{{cwd}} {{provider}} {{model}}");
  assert(bad.length === 1 && bad[0] === "cwd", JSON.stringify(bad));
});

check("字面转义不误伤已注册变量", () => {
  const r = neutralizePromptVariables("{{provider}} / {{cwd}} / {{model}}");
  assert(r.text === "{{provider}} / { {cwd}} / {{model}}", r.text);
  assert(r.offenders.length === 1 && r.offenders[0].name === "cwd", JSON.stringify(r.offenders));
});

check("内联 personaSuffix 被转义", () => {
  const yaml = [
    "- id: system-prompt",
    "  config:",
    "    includeHarnessIdentity: false",
    '    personaSuffix: "Your working directory is {{cwd}}."',
  ].join("\n");
  const g = guardPersonaScalarsInYaml(yaml);
  assert(g.offenders.length === 1, JSON.stringify(g.offenders));
  assert(g.text.includes("personaSuffix: \"Your working directory is { {cwd}}.\""), g.text);
});

check("折叠块 personaSuffix 被转义且改用字面块", () => {
  const yaml = [
    "    personaSuffix: >-",
    "      Your working directory is {{cwd}}.",
    "      Keep answers short.",
    "    other: 1",
  ].join("\n");
  const g = guardPersonaScalarsInYaml(yaml);
  assert(g.offenders.length === 1, JSON.stringify(g.offenders));
  assert(g.text.includes("personaSuffix: |-"), g.text);
  assert(g.text.includes("Your working directory is { {cwd}}."), g.text);
  assert(g.text.trim().endsWith("other: 1"), "折叠块范围越界，吃掉了后面的键");
});

check("已注册但可能无值的变量也不许留在 persona 标量", () => {
  // 宿主第二道雷：provider / model 名注册过，value 为 undefined 时照样抛
  // prompt variable "{{provider}}" has no value for this assembly。
  const yaml = '    personaSuffix: "model={{model}} provider={{provider}}"';
  const g = guardPersonaScalarsInYaml(yaml);
  assert(g.offenders.length === 2, JSON.stringify(g.offenders));
  assert(!/\{\{(model|provider)\}\}/.test(g.text), g.text);
});

check("干净的 persona 标量一字不动", () => {
  const yaml = [
    "    personaPrefix: \"\"",
    "    personaSuffix: \"\"",
    "    text: |-",
    "      {{cwd}} 是普通正文，这里不是 persona 标量",
  ].join("\n");
  const g = guardPersonaScalarsInYaml(yaml);
  assert(g.offenders.length === 0, JSON.stringify(g.offenders));
  assert(g.text === yaml, "干净的 YAML 被改写了");
});

check("插件自带 cordis.patch.yml 无未注册变量", () => {
  const libDir = path.join(root, "lib");
  const report = checkPluginCordisPatch(libDir);
  assert(fs.existsSync(pluginCordisPatchPath(libDir)), `找不到 ${pluginCordisPatchPath(libDir)}`);
  assert(report.offenders.length === 0, `${report.path}: ${JSON.stringify(report.offenders)}`);
});

check("overlayOfficialIdentity 产出的后缀不含模板变量", () => {
  const context = { agent: { session: { header: { cwd: "D:\\indoor\\deepseekwork" } } } };
  const sections = overlayOfficialIdentity(
    [
      { name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness." },
      { name: "deployment:persona-suffix", text: "Your working directory is {{cwd}}." },
    ],
    context,
  );
  const suffix = sections.find((s) => s.name === "deployment:persona-suffix");
  assert(suffix, "没有 persona-suffix 段");
  assert(suffix.interpolate === false, `interpolate=${suffix.interpolate}`);
  assert(!suffix.text.includes("{{"), suffix.text);
  assert(suffix.text === "Your working directory is D:\\indoor\\deepseekwork.", suffix.text);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
