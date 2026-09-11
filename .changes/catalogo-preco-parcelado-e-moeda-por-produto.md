---
impacto: capacidade_nova
secao: adicionado
titulo: Catálogo ganha preço parcelado e moeda por produto
---

Cada produto do catálogo (`/app/products`) agora pode ter, além do preço à vista, um
**preço parcelado** — o valor total quando o cliente paga em várias vezes. É opcional: um
produto sem ele continua só com o preço à vista, como sempre.

Também é possível escolher a **moeda de cada produto** (Libra, Euro, Real, Peso mexicano ou
Dólar), em vez de todo o catálogo usar sempre a moeda da organização — que continua sendo a
sugestão inicial no cadastro. A importação por planilha reconhece uma coluna opcional de
preço parcelado ("preço parcelado" / "parcelado").

O agente de IA passa a saber calcular a parcela quando o cliente pede para parcelar: ele
pergunta quantas semanas e se há entrada, e divide o preço parcelado (nunca o preço à
vista) por uma ferramenta própria — o cálculo nunca é feito "de cabeça" pelo modelo.
