import OpenAI from "openai";

export async function chat({ messages, model, temperature }){
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey){
    const last = messages[messages.length-1]?.content || "";
    return { role:"assistant", content: `(Demo sin OpenAI) Respuesta basada en contexto:\n${last.slice(0,400)}` };
  }
  const client = new OpenAI({ apiKey });
  const res = await client.chat.completions.create({
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: typeof temperature === "number" ? temperature : (parseFloat(process.env.OPENAI_TEMPERATURE||"0.3")),
    messages
  });
  return res.choices[0].message;
}

export async function embed(text){
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey){
    function pseudoVec(dim=384){
      let h = 0; for (let i=0;i<text.length;i++){ h = (h*31 + text.charCodeAt(i))>>>0; }
      const rnd = (seed)=>{ let x = seed; return ()=> (x = (1664525*x + 1013904223)>>>0) / 2**32; };
      const rand = rnd(h||42);
      const v = Array.from({length:dim}, ()=> rand()-0.5);
      const norm = Math.sqrt(v.reduce((s,x)=>s+x*x,0)) || 1;
      return v.map(x=>x/norm);
    }
    return pseudoVec();
  } else {
    const client = new OpenAI({ apiKey });
    const res = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: text
    });
    return res.data[0].embedding;
  }
}
