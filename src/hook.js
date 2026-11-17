// Entry for hooks/hooks.json, run as `node "${CLAUDE_PLUGIN_ROOT}/src/hook.js" <note|cost>`.
// It does exactly what `pushreel note hook` and `pushreel cost hook` do: reads the hook input (JSON with
// session_id and cwd) from stdin, reads only local files under the project's .pushreel/ folder and the
// session transcript's token counts, and sends nothing anywhere. Any other argument does nothing.
import { main } from './cli.js';

const which = process.argv[2];
if (which === 'note' || which === 'cost') main([which, 'hook']);
