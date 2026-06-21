// MIT License — see LICENSE file

/** Extract the numeric answer from a model response string. */
export function extractNumericAnswer(response: string): number | null {
  // Try "The answer is N" or "= N" or bare number at end
  const patterns = [
    /the answer is\s*[-]?\d*\.?\d+/i,
    /=\s*([-]?\d*\.?\d+)/,
    /([-]?\d*\.?\d+)\s*$/,
  ];
  for (const pat of patterns) {
    const m = pat.exec(response);
    if (m) {
      const numStr = m[1] ?? m[0];
      const num = parseFloat(numStr.replace(/[^\d.-]/g, ""));
      if (!isNaN(num)) return num;
    }
  }
  return null;
}

/** Check if response contains any of the correct answers (case-insensitive). */
export function matchesTruthfulQA(
  response: string,
  correctAnswers: string[],
  incorrectAnswers: string[],
): boolean {
  const resp = response.toLowerCase();
  const hasCorrect = correctAnswers.some((a) => resp.includes(a.toLowerCase()));
  const hasIncorrect = incorrectAnswers.some((a) => resp.includes(a.toLowerCase()));
  return hasCorrect && !hasIncorrect;
}

/** Check if response contains the expected answer substring. */
export function matchesSQuAD(response: string, answer: string): boolean {
  return response.toLowerCase().includes(answer.toLowerCase());
}

/** Check if the response contains a valid function call for the expected tool. */
export function matchesBCFL(
  response: string,
  expectedCall: { name: string; arguments: Record<string, unknown> },
): boolean {
  try {
    // Look for JSON tool call in response
    const jsonMatch = /\{[\s\S]+\}/.exec(response);
    if (!jsonMatch) return false;
    const parsed = JSON.parse(jsonMatch[0]) as { name?: string; arguments?: unknown };
    return parsed.name === expectedCall.name;
  } catch {
    // Simple text match fallback
    return response.includes(expectedCall.name);
  }
}

export interface BenchmarkResult {
  name: string;
  totalSamples: number;
  baselineCorrect: number;
  compressedCorrect: number;
  baselineAccuracy: number;
  compressedAccuracy: number;
  accuracyDelta: number;
  avgCompressionRatio: number;
  passed: boolean;
  threshold: number;
  thresholdType: "accuracy_delta" | "min_accuracy";
}
