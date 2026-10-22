/**
 * 提示词变量闸门（防回归）。
 *
 * 事故：dsh-purge 1.1.71 把 bundle patch 的 personaSuffix 写成
 * `Your working directory is {{cwd}}.`。DSH 0.2.1 的 renderPrompt 只注册
 * provider / model，`{{cwd}}` 于是抛
 *   unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
 *   registered variables: provider, model
 * 整轮对话直接失败——不是提示词变丑，是起不来。
 *
 * 所以 persona 标量（personaPrefix / personaSuffix / persona / prefix / suffix）
 * 里出现「宿主没注册」的变量时：线上把它拆成 `{ {name}}}` 当字面文本，
 * 并留一条 offenders 报告，谁改的、改在哪一行都能查到。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** DSH 0.2.x 实际注册的提示词变量。多一个都别加：多一个就是一次整轮失败。 */
export const HOST_REGISTERED_PROMPT_VARS = new Set(["provider", "model"]);

/**
 * persona 标量里一个变量都不许留。
 *
 * 宿主有第二道雷：名字注册了，value 是 undefined 时照样抛
 *   prompt variable "{{provider}}" has no value for this assembly
 * （provider / model 在极简装配、子代理、离线 provider 上就可能没有值）。
 * 所以 personaSuffix 这类「装配必过的段」只写死字面文本。
 */
const PERSONA_SAFE_PROMPT_VARS = new Set();

const VARIABLE_RE = /\{\{([^{}]*)\}\}/g;

const PERSONA_KEY_RE = /^(\s*)(personaPrefix|personaSuffix|persona|prefix|suffix)\s*:\s*(.*?)\s*$/;

const BLOCK_HEADER_RE = /^[>|][-+]?$/;

/** 扫出所有 `{{name}}` 变量引用（带行号，方便报错指到行）。 */
export function findPromptVariables(text) {
  const src = String(text ?? "");
  const out = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    VARIABLE_RE.lastIndex = 0;
    let m = VARIABLE_RE.exec(lines[i]);
    while (m) {
      out.push({ name: String(m[1]).trim(), line: i + 1, raw: m[0] });
      m = VARIABLE_RE.exec(lines[i]);
    }
  }
  return out;
}

/** 宿主不会认的变量名（去重）。 */
export function findUnregisteredPromptVariables(text, allowed = HOST_REGISTERED_PROMPT_VARS) {
  const names = new Set();
  for (const hit of findPromptVariables(text)) {
    if (!allowed.has(hit.name)) names.add(hit.name);
  }
  return [...names];
}

/** 把未注册变量拆成 `{ {name}}}`，宿主不再当变量解析。 */
export function neutralizePromptVariables(text, allowed = HOST_REGISTERED_PROMPT_VARS) {
  const src = String(text ?? "");
  const offenders = [];
  const lines = src.split("\n").map((line, idx) => {
    VARIABLE_RE.lastIndex = 0;
    let m = VARIABLE_RE.exec(line);
    let next = "";
    let cursor = 0;
    let touched = false;
    while (m) {
      const name = String(m[1]).trim();
      if (!allowed.has(name)) {
        touched = true;
        offenders.push({ name, line: idx + 1, raw: m[0] });
        next += line.slice(cursor, m.index) + `{ {${name}}}`;
        cursor = m.index + m[0].length;
      }
      m = VARIABLE_RE.exec(line);
    }
    if (!touched) return line;
    return next + line.slice(cursor);
  });
  return { text: lines.join("\n"), offenders };
}

/** YAML 里某段折叠块 / 字面块的行区间。 */
function blockBodyRange(lines, index) {
  const keyIndent = lines[index].length - lines[index].replace(/^[ \t]+/, "").length;
  let end = index + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (!line.trim()) { end += 1; continue; }
    const indent = line.length - line.replace(/^[ \t]+/, "").length;
    if (indent <= keyIndent) break;
    end += 1;
  }
  return { start: index + 1, end };
}

/**
 * 只检查 / 修 persona 标量，不动 YAML 其它内容。
 * 返回值：{ text, offenders }，offenders 为空表示这段 YAML 是干净的。
 */
export function guardPersonaScalarsInYaml(yaml, allowed = PERSONA_SAFE_PROMPT_VARS) {
  const src = String(yaml ?? "");
  if (!src.trim() || !src.includes("{{")) return { text: src, offenders: [] };
  const lines = src.split("\n");
  const offenders = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = PERSONA_KEY_RE.exec(lines[i]);
    if (!m) continue;
    const value = m[3] ?? "";
    if (BLOCK_HEADER_RE.test(value)) {
      const { start, end } = blockBodyRange(lines, i);
      let changed = false;
      for (let j = start; j < end; j += 1) {
        const r = neutralizePromptVariables(lines[j], allowed);
        if (r.offenders.length === 0) continue;
        lines[j] = r.text;
        changed = true;
        offenders.push(...r.offenders.map((o) => ({ ...o, line: j + 1, key: m[2] })));
      }
      if (changed) {
        // 折叠块改字面块：拆开的 `{ {` 必须原样保留。
        lines[i] = `${m[1]}${m[2]}: |-`;
      }
      i = end - 1;
      continue;
    }
    const r = neutralizePromptVariables(value, allowed);
    if (r.offenders.length === 0) continue;
    lines[i] = `${m[1]}${m[2]}: ${r.text}`;
    offenders.push(...r.offenders.map((o) => ({ ...o, line: i + 1, key: m[2] })));
  }
  return { text: lines.join("\n"), offenders };
}

/** 一行人话报告，给 console.warn 用。 */
export function describeOffenders(offenders) {
  return (offenders || [])
    .map((o) => `${o.key ? `${o.key} ` : ""}line ${o.line}: {{${o.name}}}`)
    .join("; ");
}

/** 插件自带 cordis.patch.yml 的绝对路径。 */
export function pluginCordisPatchPath(moduleDir) {
  const base = moduleDir || path.dirname(fileURLToPath(import.meta.url));
  return path.join(base, "..", "cordis.patch.yml");
}

/** 启动自检：读插件 patch 文件，返回未注册变量报告（不抛异常）。 */
export function checkPluginCordisPatch(moduleDir, fsImpl = fs) {
  const fp = pluginCordisPatchPath(moduleDir);
  let text = "";
  try {
    if (!fsImpl.existsSync(fp)) return { path: fp, ok: true, offenders: [] };
    text = String(fsImpl.readFileSync(fp, "utf8"));
  } catch (err) {
    return { path: fp, ok: false, offenders: [], error: String(err?.message || err) };
  }
  const { offenders } = guardPersonaScalarsInYaml(text);
  return { path: fp, ok: offenders.length === 0, offenders };
}
