// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V219 - feedback `good`/`bad` counters fold into star ratings
 *
 * `data/usage.json` kept thumbs-style `good` and `bad` counters next to the
 * 1-5 star ratings. Every new star rating bumped them as well (4-5 = good,
 * 1-3 = bad), so they carry no information the ratings do not. Only counts
 * recorded before star ratings existed live in them alone. This folds those
 * into the ratings (good = 5 stars, bad = 1 star) when the ratings of that
 * bucket are still empty, then removes both counters from the total and from
 * every per-user, per-app and per-model bucket.
 */

export const version = '219';
export const description = 'usage_feedback_good_bad_to_ratings';

const USAGE_FILE = 'data/usage.json';
const GROUPS = ['perUser', 'perApp', 'perModel'];

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function averageRating(ratings) {
  let count = 0;
  let sum = 0;
  for (const [rating, n] of Object.entries(ratings)) {
    count += n;
    sum += Number.parseInt(rating, 10) * n;
  }
  return count === 0 ? 0 : sum / count;
}

/** Fold and strip one feedback bucket; true when the bucket changed. */
function convertBucket(bucket) {
  if (!isObject(bucket) || !('good' in bucket || 'bad' in bucket)) return false;
  const good = Number(bucket.good) || 0;
  const bad = Number(bucket.bad) || 0;
  const ratings = isObject(bucket.ratings) ? bucket.ratings : { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const empty = Object.values(ratings).every(n => !n);
  if (empty && (good > 0 || bad > 0)) {
    ratings[5] = (ratings[5] || 0) + good;
    ratings[1] = (ratings[1] || 0) + bad;
    bucket.total = good + bad;
    bucket.averageRating = averageRating(ratings);
  }
  bucket.ratings = ratings;
  delete bucket.good;
  delete bucket.bad;
  return true;
}

export async function precondition(ctx) {
  return ctx.fileExists(USAGE_FILE);
}

export async function up(ctx) {
  let usage;
  try {
    usage = await ctx.readJson(USAGE_FILE);
  } catch (error) {
    ctx.warn(`Skipped ${USAGE_FILE}: ${error.message}`);
    return;
  }
  const feedback = usage?.feedback;
  if (!isObject(feedback)) return;

  let changed = convertBucket(feedback);
  for (const group of GROUPS) {
    if (!isObject(feedback[group])) continue;
    for (const bucket of Object.values(feedback[group])) {
      if (convertBucket(bucket)) changed = true;
    }
  }

  if (changed) {
    await ctx.writeJson(USAGE_FILE, usage);
    ctx.log('feedback good/bad counters folded into star ratings and removed');
  }
}
