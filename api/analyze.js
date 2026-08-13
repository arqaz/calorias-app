export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const { image, mediaType } = req.body || {};
  if (!image || !mediaType) {
    res.status(400).json({ error: 'Imagem em falta' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Chave de API não configurada no servidor' });
    return;
  }

  const prompt = `Olha para esta foto de um prato de comida e estima o valor nutricional de UMA dose visível na imagem.
Responde APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, com exatamente estes campos:
{
  "food_name": "nome curto do prato em português",
  "description": "descrição breve dos ingredientes principais, em português, máximo 12 palavras",
  "calories": número inteiro (estimativa central de kcal para a dose mostrada),
  "protein_g": número,
  "carbs_g": número,
  "fat_g": número,
  "fiber_g": número,
  "confidence": "alta" | "média" | "baixa",
  "emoji": "um único emoji que represente o prato"
}
Se não conseguires identificar comida na imagem, define food_name como "Não foi possível identificar" e os valores numéricos como 0.`;

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
              { inlineData: { mimeType: mediaType, data: image } },
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
    res.status(500).json({ error: 'Falha ao analisar a imagem', details: String(err) });
  }
}
