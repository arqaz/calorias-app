export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const { currentImage, currentMediaType, previousImage, previousMediaType, objective } = req.body || {};
  if (!currentImage || !currentMediaType || !previousImage || !previousMediaType) {
    res.status(400).json({ error: 'Imagens em falta' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Chave de API não configurada no servidor' });
    return;
  }

  const objectiveLabel = {
    perder: 'perder peso',
    manter: 'manter o peso e a forma física atual',
    ganhar: 'ganhar massa muscular',
  }[objective] || 'o objetivo pessoal que definiu na app';

  // Nota de conceção (ver também o PR que introduziu este ficheiro): esta
  // funcionalidade dá feedback de progresso a partir de duas fotos da mesma
  // pessoa, com regras estritas para evitar avaliações de aparência,
  // estimativas clínicas (peso, % de gordura corporal) ou comentários que
  // possam alimentar problemas de imagem corporal. As sugestões devem ser
  // sempre sobre hábitos (nutrição, treino, consistência), nunca sobre a
  // aparência física em si.
  const prompt = `Vais comparar duas fotografias de progresso pessoal da MESMA pessoa, tiradas em momentos diferentes, para dar feedback construtivo sobre o progresso visível rumo ao objetivo declarado: ${objectiveLabel}.

Regras obrigatórias:
- Comenta APENAS aspetos objetivos e visíveis relacionados com o objetivo (ex: definição muscular aparente, postura, distribuição corporal aparente). NUNCA comentes atratividade, valor pessoal, idade aparente ou faças qualquer juízo sobre a pessoa.
- NUNCA estimes peso, percentagem de gordura corporal, IMC ou qualquer valor clínico/numérico a partir das imagens — não é possível fazê-lo com fiabilidade a partir de fotos e não deves tentar.
- Usa sempre um tom construtivo, respeitoso e encorajador. Nunca uses linguagem negativa, crítica ou de "body shaming".
- As sugestões devem ser sobre HÁBITOS (nutrição, treino, hidratação, consistência, descanso) que ajudam a progredir em direção ao objetivo — nunca sugestões sobre a aparência física em si (ex: nunca sugerir "perder mais peso" ou comentar partes do corpo).
- Se as duas fotos não permitirem uma comparação fiável (pose, ângulo, enquadramento, iluminação ou roupa muito diferentes, ou não for possível identificar mudanças com confiança), diz isso honestamente em vez de inventar observações.
- Se não houver diferenças visíveis relevantes, diz isso também — não inventes progresso que não existe.

Responde APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, com exatamente esta estrutura:
{
  "comparable": boolean (true se foi possível fazer uma comparação minimamente fiável entre as duas fotos),
  "summary": "1 a 2 frases em português, tom construtivo, resumindo o que se observa (ou explicando porque não foi possível comparar)",
  "observations": ["até 3 observações curtas em português sobre o que parece estar a mudar ou a manter-se, alinhadas com o objetivo — array vazio se comparable=false ou se não houver nada de relevante a assinalar"],
  "suggestions": ["até 3 sugestões práticas e específicas em português sobre HÁBITOS (nunca sobre aparência) para continuar a aproximar-se do objetivo — array vazio se não houver nada relevante a sugerir"]
}`;

  try {
    const model = 'gemini-flash-latest';
    const apiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { text: 'Foto de referência (mais antiga):' },
              { inlineData: { mimeType: previousMediaType, data: previousImage } },
              { text: 'Foto atual (mais recente):' },
              { inlineData: { mimeType: currentMediaType, data: currentImage } },
            ],
          }],
          generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      res.status(502).json({ error: 'Erro na API do Gemini', details: errText });
      return;
    }

    const data = await apiResponse.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      res.status(502).json({ error: 'Resposta sem conteúdo de texto' });
      return;
    }

    const clean = text
      .trim()
      .replace(/^```json/i, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();

    const parsed = JSON.parse(clean);
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao gerar feedback de progresso', details: String(err) });
  }
}
