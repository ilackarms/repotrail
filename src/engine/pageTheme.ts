/**
 * Color tokens for RepoTrail's HTML pages: light by default, dark when the
 * system prefers it or the page sets `data-theme="dark"`.
 */

const DARK_TOKENS = `
    color-scheme: dark;
    --bg: #171717;
    --panel: #232323;
    --panel-2: #2d2a25;
    --chrome: #1c1b19;
    --line: #403d38;
    --rule: rgba(255, 255, 255, 0.03);
    --text: #f4f0e8;
    --text-soft: #dfd8ce;
    --muted: #afa89e;
    --accent: #2fb7a3;
    --on-accent: #071412;
    --accent-2: #f0b84d;
    --danger: #ef7466;
    --danger-fg: #f6c8c1;
    --code-bg: #101010;
    --gutter-bg: #151515;
    --gutter-fg: #7c776f;
    --code-hi: rgba(47, 183, 163, 0.2);
    --delete-bg: rgba(239, 116, 102, 0.16);
    --insert-bg: rgba(47, 183, 163, 0.16);
    --track: #2a2927;
    --shadow: 0 18px 44px rgba(0, 0, 0, 0.42);`;

export const THEME_CSS = `
  :root {
    color-scheme: light;
    --bg: #f6f4ef;
    --panel: #ffffff;
    --panel-2: #e8f3f0;
    --chrome: #efece6;
    --line: #dcd6cc;
    --rule: rgba(0, 0, 0, 0.05);
    --text: #1f1c18;
    --text-soft: #34302a;
    --muted: #6c665d;
    --accent: #0f7f6f;
    --on-accent: #ffffff;
    --accent-2: #8f5a00;
    --danger: #b93a2b;
    --danger-fg: #8c2a1e;
    --code-bg: #fbfaf7;
    --gutter-bg: #f1eee8;
    --gutter-fg: #9b958b;
    --code-hi: rgba(15, 127, 111, 0.13);
    --delete-bg: rgba(185, 58, 43, 0.12);
    --insert-bg: rgba(15, 127, 111, 0.13);
    --track: #e2ddd4;
    --shadow: 0 18px 44px rgba(0, 0, 0, 0.16);
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {${DARK_TOKENS}
    }
  }

  :root[data-theme="dark"] {${DARK_TOKENS}
  }
`;
