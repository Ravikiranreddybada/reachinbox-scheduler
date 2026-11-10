# Architecture

| File                       | Content                                                 |
| -------------------------- | ------------------------------------------------------- |
| [overview.md](overview.md) | Guarantees, enforcement, failure matrix, scale-out path |
| [diagrams/](diagrams/)     | Interactive system diagram and its source               |

Decisions behind the design: [../adr/](../adr/).

Rule: if code changes a guarantee or failure behavior, update `overview.md` in the same change.
