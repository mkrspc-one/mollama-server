COMPONENT: TreeView

A tree like the folders in a file explorer. It opens fully closed, showing only the top level; the user clicks the small arrow beside a branch to open it. A line with others inside it shows a folder icon; a line with none shows a file icon.

Written as `<TreeView> ... </TreeView>` with Item tags between. It has no attributes of its own.

| Tag | Attributes | What it does on screen |
|---|---|---|
| `<Item />` | label | One line of the tree. Written as `<Item label="..." />`, or as `<Item label="..."> ... </Item>` with more Items inside for a branch. Lines at the same level are put in alphabetical order, whatever order they were written in. A long label is cut with … on one line. |

Clicking a line highlights it and does nothing else. Keep to six levels deep: beyond that the indentation stops growing in step.

```component
<TreeView>
  <Item label="src">
    <Item label="index.js" />
    <Item label="styles.css" />
  </Item>
  <Item label="README.md" />
</TreeView>
```
Shows "README.md" and a closed "src" folder; opening src shows its two files.
