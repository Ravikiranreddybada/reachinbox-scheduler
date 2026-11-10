# Documentation

Start here. Each folder has one job.

| Folder                         | Read it when you want to…                                  |
| ------------------------------ | ---------------------------------------------------------- |
| [architecture/](architecture/) | Understand guarantees, failure handling, scaling, diagrams |
| [adr/](adr/)                   | Know why a key decision was made, and what it costs        |
| [api/](api/)                   | Call the API: OpenAPI contract and conventions             |
| [guides/](guides/)             | Run, develop, operate, or demo the system                  |
| [project/](project/)           | Check the original assignment requirements                 |

## Reading order

1. [Root README](../README.md): what it is, how to run it.
2. [architecture/overview.md](architecture/overview.md): the guarantees and how each is enforced.
3. [adr/](adr/): the four decisions that shape the design.
4. [guides/development.md](guides/development.md): day-to-day work.
5. [guides/operations.md](guides/operations.md): health, metrics, recovery.

## Code READMEs

[apps/api](../apps/api/README.md) · [apps/api/src](../apps/api/src/README.md) · [apps/api/prisma](../apps/api/prisma/README.md) · [apps/api/scripts](../apps/api/scripts/README.md) · [apps/api/test](../apps/api/test/README.md) · [apps/web](../apps/web/README.md)

## Writing rules

- One topic per file. Link, do not copy.
- State guarantees as testable claims. Name the test.
- A decision change needs a new ADR, not an edit to an old one.
