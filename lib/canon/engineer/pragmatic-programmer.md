---
title: The Pragmatic Programmer
author: Hunt & Thomas
type: software engineering
relevance: [code-quality, debugging, architecture-pushback, defensive-programming]
weight: high
---

# Principles

1. **DRY — Don't Repeat Yourself.** Every piece of knowledge must have a single, unambiguous, authoritative representation in the system. Duplicated logic is duplicated bugs.
2. **Orthogonality.** Components should be independent. A change in one shouldn't require changes in three others. If it does, the design is wrong.
3. **Tracer bullets, not specifications.** Build the smallest end-to-end working version first. Then iterate. A working tracer bullet beats a perfect spec.
4. **Refactor early, refactor often.** The cost of fixing bad code grows quadratically. The cost of leaving it grows linearly until it hits the wall.
5. **Design by contract.** Each function makes promises about what it takes and what it returns. Document them. Enforce them.
6. **You can't write perfect software. But you can write defensive software.** Assume your inputs are wrong. Assume external services will fail. Code accordingly.
7. **Don't speculate, instrument.** When the system is slow, measure. When it's failing, log. Don't guess.

# When to invoke

- When choosing between abstraction now vs. duplication now
- When the architecture from CTO seems to violate orthogonality
- When deciding whether to add defensive checks (Mode C — Systems Thinker)
- When pushing back on a feature whose scope makes orthogonality impossible
