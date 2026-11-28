const styles = `
  :root {
    color-scheme: light;
    --paper: #f4f4ef;
    --white: #fff;
    --ink: #17191b;
    --quiet: #51565a;
    --line: #d4d6d1;
    --signal: #dce8f3;
    --radius: 1rem;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 1rem/1.65 system-ui, sans-serif; }
  .shell { width: min(100% - 3rem, 70rem); margin-inline: auto; }
  header { border-bottom: 1px solid var(--line); }
  .masthead { min-height: 4.5rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .brand { font: 900 1.65rem/1 Arial, sans-serif; letter-spacing: -.075em; color: var(--ink); text-decoration: none; }
  .masthead nav a { font-size: .9rem; font-weight: 650; color: var(--ink); text-underline-offset: .25em; }
  main { padding-block: clamp(1.2rem, 5vw, 3.25rem) 3rem; }
  .hero { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); border-radius: var(--radius); overflow: hidden; background: var(--ink); color: var(--white); }
  .hero-main, .path { padding: clamp(1.5rem, 4.4vw, 3rem); }
  .hero-main { min-width: 0; }
  h1, h2, h3, p { margin: 0; }
  h1 { font: 800 clamp(2rem, 4.2vw, 3.65rem)/1.16 Arial, system-ui, sans-serif; letter-spacing: -.04em; }
  h2 { font-size: clamp(1.5rem, 3vw, 2.15rem); line-height: 1.25; letter-spacing: -.035em; }
  h3 { font-size: 1.05rem; line-height: 1.3; }
  .hero-main > p, .hero-main > form, .hero-main > details, .hero-main > .connections, .hero-main > .token-panel { margin-top: 1rem; }
  .lead { max-width: 31rem; color: #cbd0d2; }
  .actions { display: flex; align-items: center; gap: .75rem 1.25rem; flex-wrap: wrap; }
  .hero-main .actions { margin-top: 1.5rem; }
  a { color: inherit; }
  .button, button {
    display: inline-flex; min-height: 2.75rem; align-items: center; justify-content: center; gap: .75rem;
    border: 1px solid var(--line); border-radius: .55rem; padding: .55rem 1rem; color: var(--ink);
    background: var(--white); font: 650 .93rem/1.35 system-ui, sans-serif; text-decoration: none; cursor: pointer;
  }
  .button[hidden], button[hidden] { display: none; }
  .primary { background: var(--signal); border-color: var(--signal); padding-inline: 1.2rem; min-height: 3rem; }
  .primary:hover { background: var(--white); }
  .secondary { color: var(--white); text-underline-offset: .3em; font-size: .92rem; }
  :focus-visible { outline: 2px solid #597ac3; outline-offset: 4px; }
  .hero-main [role="status"] { padding: .8rem 1rem; background: #31383d; border-left: 3px solid var(--signal); border-radius: .35rem; }
  .path { position: relative; isolation: isolate; overflow: hidden; background: #24272a; border-left: 1px solid #414548; }
  .path::before, .path::after {
    position: absolute; z-index: -1; content: ""; width: 19rem; height: 10rem; right: -11rem;
    border: 1px solid #70838f; border-radius: 50%; transform: rotate(-36deg); opacity: .4;
    box-shadow: 0 0 0 1.15rem #24272a, 0 0 0 calc(1.15rem + 1px) #70838f, 0 0 0 2.3rem #24272a, 0 0 0 calc(2.3rem + 1px) #70838f;
  }
  .path::before { top: 2rem; }
  .path::after { bottom: -1rem; }
  .path h2 { font-size: 1rem; letter-spacing: 0; }
  .path ol { list-style: none; padding: 0; margin: 1.1rem 0 0; }
  .path li { position: relative; display: grid; grid-template-columns: 2.2rem minmax(0, 1fr); align-items: start; gap: .65rem; min-height: 3.1rem; color: #d0d3d5; }
  .path li:not(:last-child)::before { content: ""; position: absolute; left: .95rem; top: 1.7rem; bottom: 0; border-left: 1px solid #646a6e; }
  .step-number { display: grid; place-items: center; width: 2rem; height: 1.75rem; border: 1px solid #687378; border-radius: .4rem; font: .78rem ui-monospace, monospace; }
  .step-label { padding-top: .04rem; font-size: .95rem; }
  [aria-current="step"] .step-number { background: var(--signal); color: var(--ink); border-color: var(--signal); }
  [aria-current="step"] .step-label { color: var(--white); font-weight: 750; }
  .beta-form { display: grid; gap: .85rem; max-width: 31rem; }
  .beta-form label, .prompt label { display: block; font-weight: 680; }
  input, textarea { width: 100%; min-width: 0; padding: .65rem .8rem; border: 1px solid var(--line); border-radius: .45rem; background: var(--white); color: var(--ink); font: inherit; }
  .beta-form :is(input, textarea) { margin-top: .3rem; }
  textarea { resize: vertical; }
  .beta-form button { justify-self: start; }
  details { padding-block: .7rem; border-top: 1px solid #4e5458; }
  summary { width: fit-content; cursor: pointer; font-weight: 650; }
  details form { margin-top: .65rem; }
  .connections { display: grid; gap: 1rem; }
  .connections > section { padding-block: .65rem; border-top: 1px solid #4e5458; }
  .connections :is(p, form, dl) { margin-top: .5rem; }
  .token-panel { padding: 1.1rem; border: 1px solid var(--signal); border-radius: .65rem; background: #242b31; }
  .token-panel h2 { font-size: 1.15rem; letter-spacing: 0; }
  .token-panel > p { margin-top: .45rem; color: #cbd0d2; font-size: .93rem; }
  .token-field { margin-top: .85rem; }
  .token-field label { display: block; font-weight: 650; font-size: .9rem; }
  .token-field :is(input, textarea) { margin-top: .3rem; font: .85rem/1.45 ui-monospace, monospace; }
  .token-panel .actions, .token-field .actions { margin-top: .55rem; }
  .hero-main .copy-status { color: #cbd0d2; }
  code { overflow-wrap: anywhere; font-family: ui-monospace, monospace; }
  dt { font-weight: 650; }
  dd { margin: 0 0 .5rem; overflow-wrap: anywhere; }
  .setup { margin-top: clamp(2.1rem, 6vw, 4rem); }
  .setup > p { margin-top: .45rem; color: var(--quiet); }
  .guide-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin-top: 1rem; }
  .card { min-width: 0; padding: clamp(1rem, 2.5vw, 1.55rem); border: 1px solid var(--line); border-radius: var(--radius); background: var(--white); }
  .card :is(p, ol) { margin-top: .6rem; }
  .card ol { margin-bottom: 0; padding-left: 1.3rem; }
  .card li + li { margin-top: .45rem; }
  .card code { background: var(--paper); padding: .15em .28em; }
  .prompt textarea { margin-top: .6rem; min-height: 8rem; background: var(--paper); }
  .prompt .actions { margin-top: .75rem; }
  .copy-status { color: var(--quiet); font-size: .88rem; }
  .portal-footer { margin-top: 1.75rem; }
  @media (max-width: 48rem) {
    .hero { grid-template-columns: minmax(0, 1fr); }
    .path { border-left: 0; border-top: 1px solid #414548; }
  }
  @media (max-width: 35rem) {
    .shell { width: calc(100% - 1.75rem); }
    .masthead { min-height: 3.65rem; }
    .hero-main, .path, .card { padding: 1.1rem; }
    .guide-grid { grid-template-columns: minmax(0, 1fr); gap: .7rem; }
    .path li { min-height: 2.6rem; }
  }
`;

const inviteSteps = ['验证邮箱并登录', 'Waiting List · 等待审核', '连接自己的 Agent'] as const;
const openSteps = ['验证邮箱并登录', '连接自己的 Agent'] as const;
export type BetaStep = 1 | 2 | 3;

export function betaAccountPage(heading: string, content: string, step: BetaStep, guide: string, footer: string,
  mode: 'invite' | 'open' = 'invite') {
  const steps = mode === 'open' ? openSteps : inviteSteps;
  const activeStep = mode === 'open' && step === 3 ? 2 : step;
  const pathHeading = mode === 'open' ? '接入流程' : '内测流程';
  const timeline = steps.map((label, index) => `<li${index + 1 === activeStep ? ' aria-current="step"' : ''}>
    <span class="step-number" aria-hidden="true">0${index + 1}</span><span class="step-label">${label}</span></li>`).join('');
  return `<!doctype html>
  <html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>EIGOS 账号</title><style>${styles}</style></head><body>
  <header><div class="shell masthead"><a href="/account" class="brand">EIGOS</a>
    ${guide ? '<nav aria-label="本页导航"><a href="#setup-heading">安装与提示词 <span aria-hidden="true">↘</span></a></nav>' : ''}
  </div></header>
  <main class="shell">
    <section class="hero" aria-labelledby="account-heading">
      <div class="hero-main"><h1 id="account-heading">${heading}</h1>${content}</div>
      <aside class="path" aria-labelledby="path-heading"><h2 id="path-heading">${pathHeading}</h2><ol>${timeline}</ol></aside>
    </section>
    ${guide}
    ${footer ? `<footer class="portal-footer">${footer}</footer>` : ''}
  </main></body></html>`;
}
