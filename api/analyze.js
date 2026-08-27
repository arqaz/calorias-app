import { requireEntitledUser, getClientIp } from '../lib/auth.js';
import { checkRateLimit } from '../lib/kv.js';
import { callGeminiJSON } from '../lib/gemini.js';

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
  const rl = await checkRateLimit('rl:analyze:' + (user ? user.sub : getClientIp(req)), 30, 3600);
  if (!rl.allowed) {
    res.status(429).json({ error: 'Demasiados pedidos. Tenta novamente daqui a pouco.' });
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

  const prompt = `Olha para esta foto de um prato de comida. Identifica cada alimento/componente distinto visível (ex: "arroz", "frango grelhado", "brócolos") e estima a quantidade de cada um em gramas.
Responde APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, com exatamente esta estrutura:
{
  "food_name": "nome curto do prato completo em português",
  "description": "descrição breve do prato, em português, máximo 12 palavras",
  "items": [
    {
      "name": "nome do alimento em português",
      "quantity_g": número inteiro (quantidade estimada em gramas visível na foto),
      "grams_per_tbsp": número (peso aproximado em gramas de UMA colher de sopa deste alimento específico, ex: arroz cozido ~15, azeite ~13, açúcar ~12, farinha ~8),
      "calories_per_100g": número,
      "protein_per_100g": número,
      "carbs_per_100g": número,
      "fat_per_100g": número,
      "fiber_per_100g": número,
      "sugar_per_100g": número,
      "sodium_per_100g_mg": número (miligramas de sódio por 100g)
    }
  ],
  "confidence": "alta" | "média" | "baixa",
  "emoji": "um único emoji que represente o prato",
  "health_score": número inteiro de 1 a 10 (qualidade nutricional geral do prato: considera densidade nutricional, equilíbrio de macros, nível de processamento, açúcar e sódio; 10 = muito saudável, 1 = pouco saudável),
  "crop_box": {
    "x": número entre 0 e 1 (posição horizontal do canto superior esquerdo da caixa que envolve o prato/comida, como fração da largura da imagem),
    "y": número entre 0 e 1 (posição vertical do canto superior esquerdo, como fração da altura da imagem),
    "width": número entre 0 e 1 (largura da caixa, como fração da largura da imagem),
    "height": número entre 0 e 1 (altura da caixa, como fração da altura da imagem)
  }
}
Lista cada alimento separadamente (não agregues tudo num só item), no máximo 6 itens. O "crop_box" deve enquadrar apertadamente o prato/comida, excluindo o máximo possível de mesa, toalha ou fundo à volta. Se não conseguires identificar comida na imagem, devolve "items" como um array vazio, food_name como "Não foi possível identificar", e "crop_box" com x:0, y:0, width:1, height:1.`;

  try {
    const parsed = await callGeminiJSON({
      apiKey,
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mediaType, data: image } },
      ],
      temperature: 0.4,
    });
    res.status(200).json(parsed);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Falha ao analisar a imagem' });
  }
}
