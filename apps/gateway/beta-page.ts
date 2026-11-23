export function betaPage(title: string, body: string) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · EIGOS</title>
  <style>
    :root{color-scheme:light;font:16px/1.65 system-ui,sans-serif;color:#191919;background:#f4f3f0}
    *{box-sizing:border-box}body{margin:0}a{color:inherit}
    header,main{max-width:68rem;margin-inline:auto;padding-inline:clamp(1.25rem,5vw,4rem)}
    header{min-height:5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid #d6d3ce}
    .brand{text-decoration:none;font-weight:750;letter-spacing:.12em;font-size:1.15rem}
    main{display:grid;grid-template-columns:1.15fr 1fr;gap:clamp(2rem,8vw,7rem);align-items:start;padding-block:clamp(2.5rem,10vw,8rem)}
    h1{font-size:clamp(2.5rem,6vw,4.8rem);line-height:1.05;letter-spacing:-.055em;margin:0 0 1.2rem}
    h2{font-size:1.2rem;line-height:1.35;margin:0 0 .8rem}p{margin:0 0 1rem}
    .lead{color:#4d4b46;max-width:30rem}.panel{background:#fff;border:1px solid #d6d3ce;padding:clamp(1.2rem,4vw,2rem);border-radius:12px;min-width:0}
    button,.button{display:inline-block;font:inherit;font-weight:650;background:#181818;color:white;padding:.7rem 1.05rem;border:1px solid #181818;border-radius:6px;text-decoration:none;cursor:pointer}
    form+form,details{margin-top:1rem}label{display:block;font-weight:600}
    input,textarea{display:block;width:100%;margin-top:.35rem;padding:.6rem .7rem;font:inherit;border:1px solid #a09d96;border-radius:5px;background:#fff;color:inherit}
    textarea{resize:vertical}small{display:block;color:#55524d;margin:.4rem 0 .9rem}
    summary{cursor:pointer;font-size:.875rem;color:#4d4b46}details form{margin-top:.75rem}
    a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #3165b1;outline-offset:3px}
    @media(max-width:44rem){main{grid-template-columns:1fr;gap:1.6rem}}
  </style>
</head>
<body>
  <header><a class="brand" href="/beta" aria-label="EIGOS Beta 首页">EIGOS</a><a href="/account">账号</a></header>
  <main>
    <section><h1>${title}</h1><p class="lead">连接你的 AI 助手，体验真实的旅行、地图和生活服务。</p></section>
    <section class="panel" aria-label="Beta 申请">${body}</section>
  </main>
</body>
</html>`;
}
