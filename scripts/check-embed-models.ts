import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const r = await fetch("https://openrouter.ai/api/v1/models");
  const j = await r.json();
  const all = j.data ?? [];
  console.log(`total: ${all.length}`);
  for (const m of all) {
    const arch = m.architecture ?? {};
    const combo = `${arch.modality ?? ""}|${(arch.input_modalities ?? []).join(",")}|${(arch.output_modalities ?? []).join(",")}`;
    if (/embed/i.test(combo) || /embed/i.test(m.id) || /embed/i.test(m.name ?? "")) {
      console.log(`${m.id} | price=${m.pricing?.prompt}/${m.pricing?.completion} | ${combo}`);
    }
  }
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
process.on("exit", () => process.exit(0));
