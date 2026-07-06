/**
 * maw corrections — CLI for oracle correction memory
 *
 * Usage:
 *   maw corrections add <oracle> 'wrong' 'correct' ['reason']
 *   maw corrections list <oracle> [--limit N]
 *   maw corrections search <oracle> 'query'
 *
 * Calls Admin-Oracle bot API at localhost:3100/api/corrections
 */

const API_BASE = process.env.CORRECTIONS_API_URL || "http://localhost:3100/api/corrections";

export async function cmdCorrectionsAdd(args: string[]) {
  const oracle = args[0];
  const wrong = args[1];
  const correct = args[2];
  const reason = args[3] || undefined;

  if (!oracle || !wrong || !correct) {
    console.error("usage: maw corrections add <oracle> 'wrong answer' 'correct answer' ['reason']");
    process.exit(1);
  }

  try {
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oracle_name: oracle,
        question: wrong, // use wrong answer as the question context for matching
        wrong_answer: wrong,
        correct_answer: correct,
        reason,
        created_by: "bank",
      }),
    });

    const data = await res.json() as Record<string, unknown>;
    if (data.ok) {
      const c = data.correction as Record<string, unknown>;
      console.log(`\x1b[32m✓\x1b[0m Correction #${c.id} created for ${oracle}`);
      console.log(`  embedded: ${data.embedded ? "✓" : "✗ (FTS only)"}`);
    } else {
      console.error(`\x1b[31m✗\x1b[0m ${data.error}`);
    }
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m API unreachable: ${e.message}`);
    console.error("  Is Admin-Oracle bot running? (pm2 status)");
  }
}

export async function cmdCorrectionsList(args: string[]) {
  const oracle = args[0];
  let limit = 20;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) limit = Number(args[++i]);
  }

  const url = oracle
    ? `${API_BASE}/${encodeURIComponent(oracle)}?limit=${limit}`
    : `${API_BASE}?limit=${limit}`;

  try {
    const res = await fetch(url);
    const data = await res.json() as { count: number; corrections: Array<Record<string, unknown>> };

    if (!data.corrections?.length) {
      console.log(oracle ? `No corrections for ${oracle}` : "No corrections found");
      return;
    }

    console.log(`\x1b[36m${oracle || "all"}\x1b[0m — ${data.count} correction(s)\n`);
    for (const c of data.corrections) {
      console.log(`  #${c.id} [${c.oracle_name}] ${c.category || "—"}`);
      console.log(`    \x1b[31m✗ wrong:\x1b[0m ${(c.wrong_answer as string).slice(0, 80)}`);
      console.log(`    \x1b[32m✓ correct:\x1b[0m ${(c.correct_answer as string).slice(0, 80)}`);
      if (c.reason) console.log(`    reason: ${c.reason}`);
      console.log(`    matched: ${c.times_matched}x | confidence: ${c.confidence}`);
      console.log();
    }
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m API unreachable: ${e.message}`);
  }
}

export async function cmdCorrectionsSearch(args: string[]) {
  const oracle = args[0];
  const query = args.slice(1).join(" ");

  if (!oracle || !query) {
    console.error("usage: maw corrections search <oracle> 'search query'");
    process.exit(1);
  }

  // For now, fetch all for the oracle and filter client-side
  // TODO: add server-side search endpoint with vector similarity
  const url = `${API_BASE}/${encodeURIComponent(oracle)}?limit=100`;

  try {
    const res = await fetch(url);
    const data = await res.json() as { corrections: Array<Record<string, unknown>> };

    const q = query.toLowerCase();
    const matches = (data.corrections || []).filter((c) => {
      const text = `${c.question} ${c.wrong_answer} ${c.correct_answer} ${c.reason || ""}`.toLowerCase();
      return text.includes(q);
    });

    if (!matches.length) {
      console.log(`No corrections matching "${query}" for ${oracle}`);
      return;
    }

    console.log(`\x1b[36m${oracle}\x1b[0m — ${matches.length} match(es) for "${query}"\n`);
    for (const c of matches) {
      console.log(`  #${c.id} [${c.category || "—"}]`);
      console.log(`    \x1b[31m✗\x1b[0m ${(c.wrong_answer as string).slice(0, 80)}`);
      console.log(`    \x1b[32m✓\x1b[0m ${(c.correct_answer as string).slice(0, 80)}`);
      console.log();
    }
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m API unreachable: ${e.message}`);
  }
}
