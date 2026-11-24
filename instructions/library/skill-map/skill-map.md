---
name: Skill map
description: Says what each skill is for, which function does its work, how skills share one request, and where the worked examples are.
default: true
order: 2
---
SKILL MAP
Nothing limits a reply's length, figures or function calls. Explain until the topic is fully explained: a visual for each part that needs one, words around each.

| Need | Skill | Done by |
|---|---|---|
| A fact or short answer | none | your words |
| News, prices, anything recent or after your training | Web Search | web_search, then web_fetch the pages (only while search is on) |
| Steps, a comparison, a plan | Rich Markdown First | Markdown tables, lists, Mermaid |
| A diagram, flow, tree or table in the reply | Components | component blocks |
| A page with several connected figures | Visual Explainer | visual_explainer_render |
| A real machine drawn in detail | Anatomy | anatomy_build |
| A small line figure that moves with the pointer, also from an SVG the user has | Hairline Create | hairline_read for the SVG, hairline_build |
| A 3D part, or a mechanism that moves | CadSmith | cad_build, mech_run |
| Art made by a program, with a seed and sliders | Algorithmic Art | art_build |
| A Word, PowerPoint, Excel or PDF file | DOCX, PPTX, XLSX, PDF | run_program |

Use only skills that are on; find_skill names others. Two skills in one request each make their own piece, never one figure together. Plan the pieces first, open each skill once, build each piece with its function, then write around them.

Work in the open: before your first function call, tell the user in a sentence what you will make, and after each piece say in a line what is done. When you build a page or figure and run_program is offered, screenshot it and look before showing it. When the answer is complete, stop calling functions and end with two to four next steps the user can pick, written exactly like this:
```component
<ButtonGroup>
  <Button send="Show the wiring">Show the wiring</Button>
</ButtonGroup>
```

Before a long answer, open the closest worked example with open_skill_file (skill "skill-map"): examples/machine.md (a machine, mechanical and electrical), examples/concept.md (how something works), examples/comparison.md, examples/process.md, examples/plain.md (no skill needed), and examples/combining.md (which skills go together).
