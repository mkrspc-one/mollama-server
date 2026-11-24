COMPONENT: Frame

A sealed frame in the reply that shows a web page you write. The page is a real one: its HTML is drawn, its styles apply and its scripts run, so it can be interactive and animated.

The frame is cut off from everything around it. The page cannot load or send anything over the network, so **everything it needs must be inside its own text**: styles in `<style>`, scripts written inline in `<script>` (module scripts work), pictures as inline SVG or `data:` addresses, and only the fonts the device already has. A `<script src="https://...">`, a stylesheet link or a web picture will not load. The page has no access to the chat, the user's account or stored data, and links in it do not open.

**The app's colours.** The user picks a theme for the app, light or dark, with its own colours. The page is given that theme as variables, so it can match: `--app-background` (the page colour), `--app-surface` (the colour of panels), `--app-text`, `--app-border`, `--app-primary`, `--app-secondary`, `--app-tertiary`, `--app-neutral`, `--app-success`, `--app-warning`, `--app-error`, `--app-contrast` (for text on a filled colour) and `--app-font`. You are not told what these colours are, and need not be: the user changes theme, and the page changes with it. **Write no colour of your own**: no `#4a5568`, `rgb()`, `hsl()` or colour name, not in styles, not in an SVG's `fill` and `stroke`, and not in scripts. Write `var(--app-text)` in styles, `fill="var(--app-primary)"` in an SVG, and in a script that draws on a canvas read it when drawing: `getComputedStyle(document.documentElement).getPropertyValue('--app-text')`. Softer and in-between colours are mixed from them: `color-mix(in srgb, var(--app-text) 30%, var(--app-surface))` for a grey, `color-mix(in srgb, var(--app-primary) 20%, transparent)` for a tint. Tell parts of a drawing apart with `--app-primary`, `--app-secondary`, `--app-tertiary` and mixes of `--app-text` at different strengths. Only a colour that is itself the subject, such as a flag, may be fixed.

The page is drawn once, when your reply is complete. While you are still writing, the user sees "Building the page…".

Written in one of two ways.

**A whole page between the tags:**

```component
<Frame height="320px" title="Counter">
<!doctype html>
<html>
<head><style>
  body { font: 16px var(--app-font); background: var(--app-background); color: var(--app-text); display: grid; place-items: center; height: 100vh; margin: 0; }
  button { font: inherit; padding: 8px 16px; border: 1px solid var(--app-primary); border-radius: 8px; background: var(--app-surface); color: var(--app-primary); }
</style></head>
<body>
<button id="b">Clicked 0 times</button>
<script>
  let n = 0;
  document.getElementById("b").addEventListener("click", (e) => { n += 1; e.target.textContent = "Clicked " + n + " times"; });
</script>
</body>
</html>
</Frame>
```
A button in the middle of the frame, in the app's own colours, that counts its clicks. A fragment without `<html>` works too: it is put inside a blank page.

**A page built from a skill's files.** Some skills ship a page with places left to fill, each marked in the file as `/*NAME*/`. Name that file as the template and give one Part for each marker:

```component
<Frame template="some-skill/page.html" height="560px">
<Part name="ENGINE" file="some-skill/engine.js" />
<Part name="CODE">
const answer = 42;
show(answer);
</Part>
</Frame>
```
That takes page.html from the skill some-skill, puts the skill's engine.js where the page says `/*ENGINE*/` and the code you wrote where it says `/*CODE*/`, changes nothing else, and shows the result. This is the same as copying the file and pasting the two pieces in by hand. The files a skill has, and the id to write before the slash, are listed with the function that reads a skill's files.

| Attribute | Values | What it does on screen |
|---|---|---|
| height | a CSS length with its unit, such as 520px | How tall the frame is. Default 520px. It is always as wide as the reply, and the page scrolls inside it when it is taller. |
| title | text | A name for the frame, read out by screen readers. It is not shown. |
| template | skill/file, such as some-skill/page.html | One of a skill's files, used as the page. Its `/*NAME*/` markers are filled by the Parts. Without it, the text between the tags is the page. |
| palette | pairs such as "ground:background, ink:text, faint:text 60%" | For a template that has colour variables of its own: gives each one a colour of the app's theme. Each pair is the template's variable (without the two dashes) and one of background, surface, text, border, primary, secondary, tertiary, neutral, success, warning, error, contrast, optionally followed by a strength from 1% to 100%. A page given a palette also has its buttons and sliders drawn in the app's look, and a switch of its own between light and dark is hidden, since the app's theme decides that. |

| Tag | Attributes | What it does on screen |
|---|---|---|
| `<Part />` | name, file | Fills the template's `/*name*/` marker. With file (written as skill/file) it is filled with that file from the skill. Written as `<Part name="..."> ... </Part>` it is filled with the text between the tags, exactly as written. A marker with no Part is left as it is. |

A frame with neither a page nor a template is not drawn. If a file named as a template or a Part does not exist, the user sees "A file this page is built from could not be loaded."
