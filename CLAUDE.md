# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Don't Reinvent the Wheel
- if what we are trying to do is similar to settled science or industry practice, let me know. We don't have to reinvent the wheel.
- If you see a clearly better approach, say so before implementing. Explain the tradeoff in 2-4 bullets. If the current request is still reasonable, proceed unless the alternative avoids serious risk or wasted work.

## 6. No Unexplained Jargon

**Technical terms are fine — but explain them in the same breath.**

- On first use, give every technical term a plain-language gloss: "the story's centroid (the average fingerprint of its member articles)".
- Applies everywhere the user reads: chat replies, reports, docs, artifacts, commit messages.
- Prefer the plain word when nothing is lost ("fingerprint" instead of "embedding vector"; "position" instead of "centroid" after it's been introduced once).
- Don't invent shorthand labels (story A/B/C, phase 2, …) without restating what they refer to when they reappear.

## 7. Document Every Implementation Request

**`docs/FEATURES.md` is the traceability record. Keep it current in the same change.**

- Every implementation request gets a dated entry in the Part-2 request log
  (what was asked, in short) and — once shipped — a Part-1 inventory entry
  (what was built, where it lives, status).
- Feature removals or replacements are logged there too, with what replaced
  them. Nothing disappears silently.
- This is not optional polish: the user follows progress and traces past
  decisions through this file.

## 8. Build for the Broadest Browser Support

**We develop for maximum browser compatibility, not for Chrome.**

Target browsers, in German market-share order: **Chrome, Safari, Firefox, Edge,
Samsung Internet, Opera**. Edge, Opera and Samsung Internet are Chromium, so in
practice every feature has to work in all three engines: **Blink, WebKit, Gecko**.

- No engine-exclusive feature without a working fallback. Check support before
  reaching for anything recent — today's tripwires are **CSS Anchor Positioning**
  (`anchor-name`, `position-try-*`), the **HTML `popover` attribute**, container
  queries, and `:has()` in complex selectors.
- Concrete consequence in this repo: the outlet popovers of the spectrum bar
  measure and place themselves in JavaScript (`SpectrumBar.tsx`) *because*
  anchor positioning would only work in Chromium. Don't "simplify" that back.
- Autoprefixer runs in the web build — never hand-write vendor prefixes.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
