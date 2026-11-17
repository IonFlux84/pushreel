// The failure catalogue. Every message says what happened, in which scene, what is saved
// and the next command to run. Never a bare stack trace as the first thing.

export class PushreelError extends Error {
  /**
   * @param {string} code machine name, e.g. "login_wall"
   * @param {object} f  { title, text, next: string[], scene?, retryable?, saved?, detail? }
   */
  constructor(code, f) {
    super(f.title);
    this.name = 'PushreelError';
    this.code = code;
    Object.assign(this, { title: f.title, text: f.text || '', next: f.next || [], scene: f.scene ?? null, retryable: !!f.retryable, saved: f.saved || '', detail: f.detail || '' });
  }
  toJSON() {
    return { code: this.code, title: this.title, text: this.text, next: this.next, scene: this.scene, saved: this.saved, detail: this.detail };
  }
}

export const E = {
  loginWall: (scene, from, to) => new PushreelError('login_wall', {
    scene, title: `Scene ${scene} stopped at a login page`,
    text: `${from} redirected to ${to}, and Pushreel has no way to sign in yet. There are two:\n` +
      '- Sign in once by hand (works for every app, also Google, GitHub and other OAuth logins, magic links, SSO): "pushreel login" opens a browser window, you sign in, Pushreel keeps the session in .pushreel/auth.json.\n' +
      '- A test account with a password form: set PUSHREEL_LOGIN="email:password" (a test user without 2FA) and Pushreel fills the form.',
    next: ['pushreel login   (in Claude Code: /pushreel login), then: pushreel resume', 'export PUSHREEL_LOGIN="email:password", then: pushreel resume', `pushreel resume --skip ${scene}   (export without this scene)`, 'pushreel cancel'],
  }),
  notMarked: (scene, from, to) => new PushreelError('login_wall', {
    scene, title: `Scene ${scene} stopped at a login page`,
    text: `${from} redirected to ${to}. The scene is recorded as a visitor, because it is not marked as being behind the login. Pushreel has a login for this app: add "requiresLogin": true to scene ${scene} in .pushreel/shotlist.json and it is recorded signed in.`,
    next: [`Add "requiresLogin": true to scene ${scene}, then: pushreel resume`, `pushreel resume --skip ${scene}   (export without this scene)`, 'pushreel cancel'],
  }),
  sessionExpired: (scene, from, to) => new PushreelError('session_expired', {
    scene, title: `Scene ${scene}: your saved session has expired`,
    text: `Your saved session has expired. Run /pushreel login again. (${from} sent the browser to ${to}, although .pushreel/auth.json holds a saved login.)`,
    next: ['pushreel login   (in Claude Code: /pushreel login), then: pushreel resume', `pushreel resume --skip ${scene}   (export without this scene)`, 'pushreel logout   (removes the saved session)', 'pushreel cancel'],
  }),
  loginFailed: (scene, to) => new PushreelError('login_failed', {
    scene, title: `Scene ${scene}: the test account could not sign in`,
    text: `Pushreel filled the login form with the account from PUSHREEL_LOGIN, and the app still shows ${to}. Check the email and password, or add "login.steps" to shotlist.json if your form is unusual.`,
    next: ['Fix PUSHREEL_LOGIN, then: pushreel resume', `pushreel resume --skip ${scene}`, 'pushreel cancel'],
  }),
  verification: (scene, url) => new PushreelError('verification', {
    scene, title: `Scene ${scene} stopped at a verification step`,
    text: `${url} asked for a code or a captcha. Pushreel cannot pass those. Use a test environment where they are switched off for the test user.`,
    next: [`pushreel resume --skip ${scene}`, 'pushreel cancel'],
  }),
  elementNotFound: (scene, what, tries) => new PushreelError('element_not_found', {
    scene, retryable: true, title: `Scene ${scene} could not find ${what}`,
    text: `The element was not on the page after ${tries} ${tries === 1 ? 'try' : 'tries'}. The page may have changed since the shot list was made.`,
    next: [`Edit scene ${scene} in .pushreel/shotlist.json (or in the Studio), then: pushreel resume`, `pushreel resume --skip ${scene}`, 'pushreel cancel'],
  }),
  appDown: (scene, base) => new PushreelError('app_down', {
    scene, retryable: true, title: `Your app stopped answering during scene ${scene}`,
    text: `${base} did not respond. Check the terminal where your dev server runs, or .pushreel/app.log if Pushreel started it.`,
    next: ['Start the app again, then: pushreel resume', 'pushreel cancel'],
  }),
  pageError: (scene, url, status) => new PushreelError('page_error', {
    scene, retryable: true, title: `Scene ${scene} hit an error page`,
    text: `${url} returned a ${status}. The screenshot is saved.`,
    next: ['Fix the page, then: pushreel resume', `pushreel resume --skip ${scene}`, 'pushreel cancel'],
  }),
  timeout: (scene, what) => new PushreelError('timeout', {
    scene, retryable: true, title: `Scene ${scene} timed out`,
    text: `${what} took too long, even with the waits doubled twice.`,
    next: [`Raise the wait in scene ${scene} of .pushreel/shotlist.json, then: pushreel resume`, `pushreel resume --skip ${scene}`, 'pushreel cancel'],
  }),
  stopped: () => new PushreelError('stopped', {
    title: 'Run stopped by you', text: 'Recorded scenes are kept. Your app keeps running until you resume or cancel.',
    next: ['pushreel resume', 'pushreel cancel'],
  }),
  ffmpegMissing: () => new PushreelError('ffmpeg_missing', {
    title: 'ffmpeg was not found',
    text: 'Cutting needs ffmpeg and ffprobe on your PATH. Install it with: brew install ffmpeg (macOS), sudo apt install ffmpeg (Debian, Ubuntu), winget install ffmpeg (Windows).',
    next: ['Install ffmpeg, then: pushreel resume   (recorded scenes are kept)'],
  }),
  browserMissing: () => new PushreelError('browser_missing', {
    title: 'The recording browser is not installed',
    text: 'Pushreel records with Playwright\'s Chromium. It is downloaded once, about 100 MB.',
    next: ['pushreel setup'],
  }),
  diskFull: () => new PushreelError('disk_full', {
    title: 'Not enough disk space to export',
    text: 'The export could not be written. Free some space and render again. The recordings are saved.',
    next: ['pushreel rerender'],
  }),
  noLicence: () => new PushreelError('no_licence', {
    title: 'Pushreel is not activated on this machine',
    text: 'Recording needs a licence key. One edition, EUR 79 once. The key is checked once when you activate. Works offline. At most once every 30 days, when you are online and start a recording, Pushreel re-checks the key with Dodo Payments. Offline never blocks.',
    next: ['pushreel activate <your-licence-key>   (in Claude Code: /pushreel activate <your-licence-key>)'],
  }),
  licenceRevoked: (code, key) => new PushreelError('licence_revoked', code === 'instance_removed' ? {
    title: 'This machine is no longer activated',
    text: `The last check with the licence provider said that the activation of this machine was removed (key ${key}). The key itself is still good. Nothing was recorded.`,
    next: ['pushreel activate <your-licence-key>   (activates this machine again)', 'pushreel licence check   (asks the provider again)'],
  } : {
    title: 'This licence key is no longer valid',
    text: `The last check with the licence provider said that key ${key} was refunded, disabled or has expired, so recording is switched off. Nothing was recorded. Your shot lists, footage and finished videos are untouched.`,
    next: ['pushreel licence check   (asks the provider again, if you think this is a mistake)', 'pushreel activate <your-licence-key>   (with a new key)', 'Questions: hello@pushreel.dev'],
  }),
  appNotStarted: (cmd, tail) => new PushreelError('app_not_started', {
    title: 'Your app did not start',
    text: cmd ? `"${cmd}" did not answer on a local port in time. The last lines of its output are below. Fix it in your terminal, or start the app yourself and pass its address.` : 'Pushreel found no running app and no start command (no "dev" or "start" script in package.json). Start the app yourself and pass its address.',
    detail: tail || '',
    next: ['pushreel run http://localhost:3000   (in Claude Code: /pushreel http://localhost:3000)'],
  }),
  appNotRunning: (cmd, ports = []) => new PushreelError('app_not_running', {
    title: 'No app is running',
    text: `Nothing answers${ports.length ? ` on port ${ports.join(', ')}` : ' on a known port'}. ${cmd ? `Start it with "pushreel detect-app --start" (runs "${cmd}"), or pass` : 'Start the app yourself and pass'} the address of the running app.`,
    next: [cmd ? 'pushreel detect-app --start' : 'pushreel detect-app http://localhost:3000', 'pushreel explore-shot http://localhost:3000/your-page --name scene-1'],
  }),
  noShotlist: (file) => new PushreelError('no_shotlist', {
    title: 'There is no shot list yet',
    text: `${file} does not exist. In Claude Code the agent writes it after exploring your app. You can also write it by hand, see docs/ARCHITECTURE.md for the format.`,
    next: ['/pushreel   (in Claude Code)', 'pushreel run --shotlist path/to/shotlist.json'],
  }),
  invalidShotlist: (problems) => new PushreelError('invalid_shotlist', {
    title: 'shotlist.json has problems', text: problems.map((p) => `- ${p}`).join('\n'),
    next: ['Fix the lines above, then: pushreel validate-shotlist'],
  }),
  busy: (pid) => new PushreelError('busy', {
    title: 'A Pushreel run is already working in this project', text: `Process ${pid} is recording or cutting right now.`,
    next: ['pushreel status', 'Wait for it, or stop it in the Studio'],
  }),
  nothingToResume: () => new PushreelError('nothing_to_resume', {
    title: 'There is no paused run', text: 'Resume continues a run that stopped at a scene. Nothing is paused in this project.',
    next: ['pushreel run', 'pushreel status'],
  }),
};

/** Terminal rendering of a failure. */
export function formatError(e) {
  if (!(e instanceof PushreelError)) return `Pushreel hit an unexpected error: ${e && e.message ? e.message : e}\n${e && e.stack ? e.stack.split('\n').slice(1, 6).join('\n') : ''}`;
  const lines = [`✗ ${e.title}`, ''];
  if (e.text) lines.push(e.text, '');
  if (e.detail) lines.push(e.detail.trimEnd(), '');
  if (e.saved) lines.push(e.saved, '');
  if (e.next.length) { lines.push('Next:'); for (const n of e.next) lines.push(`  ${n}`); }
  return lines.join('\n');
}
