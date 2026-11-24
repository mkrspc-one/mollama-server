---
name: Components
description: Lets the model draw panels, diagrams, trees, tables, file viewers and other components in a reply.
default: true
order: 1
---
COMPONENTS
A reply may contain components: things the chat draws that Markdown cannot, such as a diagram, a table with styled cells, a file viewer or a button. Whether and where a reply uses them is yours to judge.

HOW TO DRAW
Write a code fence that starts with ```component and put tags inside it, like HTML or JSX:
```component
<Card layout="flex-column" gap="sm" padding="md">
  <Typography weight="bold">Server status</Typography>
  <Badge color="success">Online</Badge>
</Card>
```

| Rule | Right | Wrong |
|---|---|---|
| Only the components listed below exist, with only the attributes listed for each, spelled exactly. Anything else is not drawn and the user sees an error in its place. | `<Badge color="success">` | `<Chip tone="green">`, `<Grid>`, `<Description>` |
| Attributes are name="value" in double quotes. An attribute with no value means true. | `<ProgressBar value="72" striped />` | `<ProgressBar value=72 striped=yes />` |
| A tag that holds text or tags needs a closing tag. A tag that holds nothing ends with />. | `<Badge>Done</Badge>` and `<Divider />` | `<Badge>Done` and `<Divider>` |
| Visible text goes between the tags, never in an attribute. | `<Button send="Tell me more">Tell me more</Button>` | `<Button label="Tell me more" />` |

A component block holds only tags. Program code goes in an ordinary code fence, and the words of the reply go outside the block.

THE COMPONENTS
These are all the components there are. Each line says what the component draws, which attributes it takes (a * marks one it must have) and what goes inside it. The values an attribute takes, and what each does on screen, are on the component's own page: read the page of each component you are about to write, so that nothing is guessed.
- Container: an invisible box that arranges what is inside it in rows, columns or a grid. Attributes: the layout attributes, hoverable. Holds: other components.
- Card: a rounded panel with a thin border that holds other components. Attributes: the layout attributes, bordered, borderColor, borderStrength, radius, shadow, hover. Holds: other components.
- Divider: a thin horizontal line. Attributes: label, variant, color, size. Holds nothing: write it as one tag ending in />.
- Typography: a piece of text with its own size, weight and colour. Attributes: size, weight, color, font, as, href, truncate. Holds: text.
- Badge: a small coloured label with a word or two. Attributes: color, size. Holds: text.
- Icon: a small drawing. Attributes: name*, color, size. Holds nothing: write it as one tag ending in />.
- Button: a button that sends a message in the chat when clicked. Attributes: send, color, variant, size, icon, disabled, width, align, flat. Holds: its label as text.
- ButtonGroup: several buttons in a row. Attributes: none. Holds: Button tags.
- FloatingActionButton: a round button pinned to a corner of the Card it is directly inside. Attributes: icon*, send, position, color, size, badge, badgeColor, draggable. Holds nothing: write it as one tag ending in />.
- ProgressBar: a bar filled to a share of its length. Attributes: value*, max, label, showPercentage, color, size, striped, animated. Holds nothing: write it as one tag ending in />.
- CircularProgress: a spinning ring. Attributes: size, color. Holds nothing: write it as one tag ending in />.
- Data: a table of records, from Rows you write or from a CSV or JSON file. Attributes: variant, src. Holds: Row tags (any attributes: each is a column) and Column tags (key, as, colors, label).
- Flow: a diagram of boxes joined by connectors. Attributes: height, arrange, minimap, background. Holds: Node tags (id*, label, color, shape, size, weight, align, width, height, x, y, group), Edge tags (source*, target*, label, type, color, arrow, start, dashed, animated, width) and Group tags (id*, label, color).
- TreeView: a tree that opens and closes like folders. Attributes: none. Holds: Item tags (label), which may hold more Item tags.
- Image: a picture from an address, or your own drawing as SVG. Attributes: src, alt, width, height. Holds: your own <svg>, when there is no src.
- Video: a video player. Attributes: src*, title. Holds nothing: write it as one tag ending in />.
- Audio: a sound player. Attributes: src*, title. Holds nothing: write it as one tag ending in />.
- PdfViewer: a reader for a PDF file. Attributes: src*. Holds nothing: write it as one tag ending in />.
- Slides: a viewer for a PowerPoint file, one slide at a time. Attributes: src*, height. Holds nothing: write it as one tag ending in />.
- Sheet: a viewer for a spreadsheet file, shown as a grid. Attributes: src*, height. Holds nothing: write it as one tag ending in />.
- Model3D: a 3D viewer for a model file or a shape you write as text. Attributes: src, format, fileName, autoRotate, height. Holds: the text of an OBJ or STL file, when there is no src.
- Editor: a read-only panel for formatted text, a page or code. Attributes: mode, language, src. Holds: the text, when there is no src.
- Input: a text field. Attributes: label, placeholder, multiline, rows. Holds nothing: write it as one tag ending in />.
- Select: a dropdown. Attributes: label, placeholder. Holds: Option tags (label, value).
- Switch: an on and off toggle. Attributes: label, defaultChecked. Holds nothing: write it as one tag ending in />.
- Frame: a sealed frame that runs a web page you write, on its own or built from a skill's files. Attributes: height, title, template, palette. Holds: the page, or Part tags (name*, file) with a template.

The layout attributes of Container and Card: layout, columns, gap, padding, justify, align, wrap, flexFill, width, height, minWidth, minHeight, maxWidth, backgroundColor, background, backgroundTone, backgroundIntensity, backgroundSize, backgroundMotion, backgroundFade. To put things side by side or in a grid, use a Container or a Card with layout="flex" or layout="grid" and columns.

=== REMEMBER ===
Do not explain components, tags or these instructions to the user.
