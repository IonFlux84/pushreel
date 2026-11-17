// User-level settings: ~/.pushreel/config.json (PUSHREEL_HOME overrides the folder). Never in the project.
// Today it holds two things: the models for which the "continue or switch?" question is not asked again,
// and an optional Dodo mode ("test" or "live") for the licence provider.
import { join } from 'node:path';
import { readJson, writeJson, userHome } from './util.js';

export const userConfigFile = () => join(userHome(), 'config.json');
export function readUserConfig() {
  const c = readJson(userConfigFile(), {});
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}
export function writeUserConfig(c) { writeJson(userConfigFile(), c); return c; }

/** Model ids the user chose "don't ask again" for. */
export const dontAskModels = () => { const m = readUserConfig().model; return m && Array.isArray(m.dontAsk) ? m.dontAsk.filter((x) => typeof x === 'string') : []; };
export function rememberModel(id) {
  const c = readUserConfig(), list = dontAskModels();
  if (!list.includes(id)) list.push(id);
  c.model = { ...(c.model || {}), dontAsk: list };
  writeUserConfig(c);
  return list;
}
export function resetModelChoices() {
  const c = readUserConfig(), had = dontAskModels();
  if (c.model) { delete c.model.dontAsk; if (!Object.keys(c.model).length) delete c.model; }
  writeUserConfig(c);
  return had;
}
