# Markdown extras

Three default extensions add to the markdown notes are written in: GFM, Code blocks and LaTeX. Each can be turned off in the Extensions view.

## GFM

| Fruit | Colour | Count |
|:--|:--:|--:|
| **Apple** | red | 3 |
| *Pear* | green | 12 |
| `Fig` | purple | 140 |

A table is drawn as a table. Put the cursor in it (click it, or move onto it with j and k) and its markdown shows.

~~Struck through~~, and a bare address, https://example.com/docs, is a link: ⌘-click it.

- [ ] A task list item
- [x] A done one

## Code blocks

```python
def fib(n: int) -> int:
    """The nth Fibonacci number."""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`; // a template string
}
```

```rust
fn main() {
    let words = vec!["ink", "paper", "pen"];
    println!("{}", words.join(", "));
}
```

```sh
npm run check && git push origin HEAD
```

```
A block with no language stays plain, and a very long line in it shows what Wrap does: it goes on and on and on, past the edge of the note, until you choose to wrap it again.
```

## LaTeX

Inline math, like $e^{i\pi} + 1 = 0$ or $\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$, sits in the line. Prices aren't math: it cost $5 and $10.

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$

$$\mathbf{A}\mathbf{x} = \mathbf{b}$$
