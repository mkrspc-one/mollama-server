# Third-party notices

The skills in the `library` folder are taken from the projects below. Each skill file names its project in its `source` line and its licence in its `licence` line.

What Mollama changes: the header of each file is rewritten to a short form (name, description, source, licence, and what the skill needs), and when a skill is sent to a model a line naming the skill is put before it. The body of each skill is unchanged. A skill's own files (its reference pages, examples, templates and scripts) sit unchanged in a folder named after the skill, beside its page, text files only, as each project's section below says. Mollama serves them for a model to read and runs none of them.

## anthropics/skills

https://github.com/anthropics/skills

18 skills, in `anthropic`. Licence: Apache License 2.0. Written by Anthropic.

The files of each skill's folder are included, copied unchanged at commit e4bb5d960d87.

## mattpocock/skills

https://github.com/mattpocock/skills

39 skills, in `engineering`. Licence: MIT. Copyright (c) 2026 Matt Pocock.

The files of each skill's folder are included, copied unchanged at commit abeeaf95660b.

## coreyhaines31/marketingskills

https://github.com/coreyhaines31/marketingskills

53 skills, in `marketing`. Licence: MIT. Copyright (c) 2025 Corey Haines.

The files of each skill's folder are included, copied unchanged at commit 5b2b400eec1e; for the 26 skills whose page has changed since it was taken in, from the earlier commit whose page matches Mollama's copy word for word.

## Open-Medica/open-medical-skills

https://github.com/Open-Medica/open-medical-skills

49 skills, in `medical`. Licence: MIT. Copyright (c) 2026 IntelMedica.ai.

## davekilleen/dex

https://github.com/davekilleen/dex

112 skills, in `dex`. Licence: MIT. Copyright (c) 2026 Dave Killeen.

The files of each skill's folder are included, copied unchanged at commit a74e5cc8b7f0. Files a skill names outside its own folder are not.

## upstash/context7

https://github.com/upstash/context7

3 skills, in `context7`. Licence: MIT. Copyright (c) 2021 Upstash, Inc..

The files of each skill's folder are included, copied unchanged at commit b1e3611e32a8.

## mvanhorn/last30days-skill

https://github.com/mvanhorn/last30days-skill

1 skills, in `last30days`. Licence: MIT. Copyright (c) 2026 Matt Van Horn.

The files of its folder are included, copied unchanged from commit 972aa54ce099, whose page matches Mollama's copy word for word.

## wheresryan22/anatomy

https://github.com/wheresryan22/anatomy

1 skills, in `anatomy`. Licence: MIT. Copyright (c) 2026 Ryan.

Its `examples`, `kit`, `references` and `scripts` folders are included, copied unchanged from a copy of the project whose page matches Mollama's word for word. The example pages its build scripts write are left out.

## lucasmarkes/hairline

https://github.com/lucasmarkes/hairline

1 skill, in `hairline`. Licence: MIT. Copyright (c) 2026 Lucas Marques. Its second skill, Hairline Adopt, was taken out on 2026-11-24: it only passes a drawing on to Hairline Create, whose step 0 reads it.

The Hairline Create skill also comes with the files its instructions name, in `hairline/hairline-hairline-create`, copied unchanged from `skills/hairline-create` at commit 034f4bf9902c: its engine (`kernel.js`), its page (`bench.html`), its rules, concepts, source and look pages, its two examples and its build, look, read and validate scripts. Mollama serves the text files to a model and to the page that shows a figure, and runs none of the scripts.

The checks of its `validate.mjs` are also reproduced word for word in `server/controllers/ai.controller.js` (`hairlineFaults`), so the Hairline build function can make them without running a script.

Changed for Mollama on 2026-11-20, as the MIT licence allows: `bench.html` has no theme button, an icon-only play button, a label for its main slider, up to four controls a figure declares (switch, select, button, slider) and spring, damping and speed sliders; `kernel.js` has `physics()` and `setPhysics()`, which those sliders drive (its sha256 line is written for the changed file); `validate.mjs` checks a figure's `label` and `controls`, and `examples/riffle.js` shows three controls. On 2026-11-21 `bench.html` stopped showing text under its controls (a figure's `means` is now only the drawing's description for screen readers, and its list of rules is not shown), and `look.mjs` measures a page to the end of its controls. The skill's instructions say so. The same files are in `mkrspc-python/skills/hairline-create` for the sandbox.

## ItzCrazyKns/Perplexica and miurla/morphic

https://github.com/ItzCrazyKns/Perplexica (MIT, Copyright (c) 2026 ItzCrazyKns) and https://github.com/miurla/morphic (Apache License 2.0)

1 skill, in `search`: Web Search. Unlike the other skills it is not a copy. It is written for Mollama's two search tools and follows two published prompts: when to search and how to make a search stand on its own follow Perplexica's search classifier; how to answer from results follows Morphic's quick search mode, without its fixed headings, its citation on every sentence and its closing summary.

## JonFermin/cadsmith

https://github.com/JonFermin/cadsmith

4 skills, in `cadsmith`. Licence: MIT. Copyright (c) 2026 Jonathan Fermin.

Taken from `.claude/skills` at commit 00c334dd4202, each page unchanged. Beside each page are the files of the repository it names, copied unchanged at the same commit: Make Model's build123d guide, Make Mechanism's `mech` package, examples and previewer source, Edit Model's two agent pages, and Export Model's pipeline scripts. In the sandbox the whole repository is in `/root/skills/cadsmith`, with its `mech` command installed. Edit Model's review and fix agents and Export Model's Blender step are not available in Mollama.

## MIT License

Applies to every project above marked MIT, each under its own copyright line.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Apache License 2.0

Applies to the skills from anthropics/skills.

Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

## Leonxlnx/taste-skill

https://github.com/Leonxlnx/taste-skill

1 skills, in `taste`. Licence: MIT. Copyright (c) 2026 Leonxlnx.

Taken from `skills/taste-skill/SKILL.md` at commit f6b7657 (tasteskill 2.5.1). Its `library`, `references` and `scripts` folders and the two pages of `assets` its instructions name are included, copied unchanged at the same commit. The rest of `assets` (about 1,600 files) and its Stop hook are not.

## xronocode/rich-md-skill

https://github.com/xronocode/rich-md-skill

1 skills, in `richmd`. Licence: MIT. Copyright (c) xronocode.

Rich Markdown First comes with the three reference pages of `skills/rich-md-first`, copied unchanged at commit b74aa4e1841e, in `richmd/richmd-rich-md-first`.

## nicobailon/visual-explainer

https://github.com/nicobailon/visual-explainer

1 skills, in `explainer`. Licence: MIT. Copyright (c) 2025 Nico Bailon.

Visual Explainer comes with part of `plugins/visual-explainer`, copied unchanged at commit 9d5f880b7e8e, in `explainer/explainer-visual-explainer`: its reference pages, page templates, and the kit's styles, scripts and drawing defs that a built page holds. Its render and checks run in a sandbox, where the whole folder is.
