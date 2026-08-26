import { requireEntitledUser, getClientIp } from '../lib/auth.js';
import { checkRateLimit } from '../lib/kv.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const { user, error: authError } = await requireEntitledUser(req);
  if (authError) {
    res.status(authError.status).json(authError.body);
    return;
  }
  // Mesmo limite do endpoint de análise por foto — substitui-o quando a
  // pessoa opta por descrever a refeição em vez de tirar uma foto.
  const rl = await checkRateLimit('rl:meal-estimate:' + (user ? user.sub : getClientIp(req)), 30, 3600);
  if (!rl.allowed) {
    res.status(429).json({ error: 'Demasiados pedidos. Tenta novamente daqui a pouco.' });
    return;
  }

  const { description } = req.body || {};
  const descriptionText = (description || '').trim();
  if (!descriptionText) {
    res.status(400).json({ error: 'Descrição em falta' });
    return;
  }
  if (descriptionText.length > 200) {
    res.status(400).json({ error: 'Descrição demasiado longa (máximo 200 caracteres)' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Chave de API não configurada no servidor' });
    return;
  }

  const prompt = `Estima as calorias e macronutrientes da seguinte descrição de refeição, feita por uma pessoa numa app de registo de calorias, sem fotografia do prato. Sê realista — é apenas uma estimativa aproximada baseada no texto.

Descrição da pessoa: "${descriptionText}"

Regras:
- Se a descrição não indicar quantidade/porção, assume uma dose típica e razoável para esse alimento e refere isso na nota.
- "name" deve ser um nome curto e limpo para a refeição (ex: "Sandes de fiambre e queijo"), não repetir a frase toda da pessoa.
- Se a descrição não for de todo comida (ex: texto aleatório), faz a melhor interpretação possível com bom senso, ou usa calorias 0 e explica isso na nota.
- Nunca dês conselhos médicos.

Responde APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, com exatamente esta estrutura:
{
  "name": "nome curto da refeição",
  "calories": número aproximado de calorias,
  "protein_g": número aproximado de gramas de proteína,
  "carbs_g": número aproximado de gramas de hidratos de carbono,
  "fat_g": número aproximado de gramas de gordura,
  "note": "breve explicação da estimativa (porção assumida, etc.), até 15 palavras"
}`;

  try {
    const model = 'gemini-flash-latest';
    const apiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
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
    res.status(500).json({ error: 'Falha ao calcular a estimativa', details: String(err) });
  }
}
