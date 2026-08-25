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
  const rl = await checkRateLimit('rl:body-checkin:' + (user ? user.sub : getClientIp(req)), 10, 3600);
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

  // Nota importante: este endpoint serve APENAS para ajudar a enquadrar a foto
  // de forma consistente entre registos (para uma comparação justa ao longo do
  // tempo) e confirmar que a foto é tecnicamente adequada (corpo inteiro
  // visível). Não avalia, pontua nem comenta a aparência, peso ou composição
  // corporal da pessoa — isso está deliberadamente fora do âmbito do prompt.
  const prompt = `Olha para esta fotografia, tirada para um registo pessoal de progresso ao longo do tempo.
A tua única tarefa é confirmar se é tecnicamente adequada para esse fim e sugerir um enquadramento consistente. NÃO descrevas, avalies, pontues ou comentes a aparência física, peso, forma ou composição corporal da pessoa — isso não é pedido e não deves fazê-lo em nenhum campo da resposta.
Responde APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, com exatamente esta estrutura:
{
  "valid": boolean (true se for uma foto de corpo inteiro, da cabeça aos pés, de uma pessoa de pé, virada de frente para a câmara, com iluminação suficiente para se distinguir o contorno do corpo),
  "reason": "string curta em português explicando porque não é adequada, APENAS se valid=false (ex: 'não é possível ver o corpo todo', 'imagem escura ou desfocada'); string vazia se valid=true",
  "crop_box": {
    "x": número entre 0 e 1 (canto superior esquerdo, fração da largura),
    "y": número entre 0 e 1 (canto superior esquerdo, fração da altura),
    "width": número entre 0 e 1 (largura da caixa, fração da largura da imagem),
    "height": número entre 0 e 1 (altura da caixa, fração da altura da imagem)
  }
}
O "crop_box" deve enquadrar a pessoa de corpo inteiro com uma margem pequena e constante à volta (para poder comparar fotos ao longo do tempo), excluindo o máximo possível de fundo irrelevante. Se não for possível identificar uma pessoa de corpo inteiro, devolve "valid": false e "crop_box" com x:0, y:0, width:1, height:1.`;

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
            temperature: 0.2,
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
