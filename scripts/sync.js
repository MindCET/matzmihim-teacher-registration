/**
 * sync.js — Airtable → Bubble full sync
 *
 * Runs via GitHub Actions (scheduled hourly + manual dispatch).
 * Reads env vars: AIRTABLE_TOKEN, AIRTABLE_BASE, BUBBLE_URL, BUBBLE_TOKEN
 *
 * Logic:
 *   1. Fetch all Airtable records (paginated)
 *   2. Fetch all Bubble users (paginated), keyed by airtable_record_id
 *   3. For each Airtable record:
 *      - Not in Bubble → CREATE (password = phone)
 *      - In Bubble but fields differ → UPDATE (no password change)
 *      - No diff → skip
 *   4. Print summary
 */

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE  = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE = 'Teachers';
const BUBBLE_URL     = process.env.BUBBLE_URL;   // e.g. https://app.bubbleapps.io/version-test/api/1.1
const BUBBLE_TOKEN   = process.env.BUBBLE_TOKEN;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE || !BUBBLE_URL || !BUBBLE_TOKEN) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

// Strip trailing slash from Bubble URL
const BUBBLE_BASE = BUBBLE_URL.replace(/\/$/, '');

// ── Airtable ──────────────────────────────────────────────────────────────────

async function fetchAllAirtable() {
  const records = [];
  let offset = null;

  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable fetch failed ${res.status}: ${body}`);
    }

    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset || null;
  } while (offset);

  return records;
}

// ── Bubble ────────────────────────────────────────────────────────────────────

async function fetchAllBubble() {
  // Returns two Maps:
  //   byAirtableId: airtable_record_id → bubble user
  //   byEmail:      email              → bubble user
  const byAirtableId = new Map();
  const byEmail      = new Map();
  let cursor = 0;
  const limit = 100;

  while (true) {
    const url = `${BUBBLE_BASE}/obj/user?limit=${limit}&cursor=${cursor}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${BUBBLE_TOKEN}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bubble fetch failed ${res.status}: ${body}`);
    }

    const data = await res.json();
    const users = data.response?.results || [];

    for (const u of users) {
      const email = (u.email || u.authentication?.email?.email || '').toLowerCase().trim();
      if (u.airtable_record_id) byAirtableId.set(u.airtable_record_id, u);
      if (email)                byEmail.set(email, u);
    }

    const remaining = data.response?.remaining ?? 0;
    if (remaining === 0 || users.length === 0) break;
    cursor += users.length;
  }

  return { byAirtableId, byEmail };
}

async function createBubbleUser(atRecord) {
  const f = atRecord.fields;
  const body = {
    email:               (f['username'] || '').toLowerCase().trim(),
    password:            (f['טלפון']    || '').trim(),
    phone:               (f['טלפון']    || '').trim(),
    'first name':        (f['שם פרטי']  || '').trim(),
    'last name':         (f['שם משפחה'] || '').trim(),
    school:              (f['בית ספר']  || '').trim(),
    airtable_record_id:  atRecord.id,
  };

  const res = await fetch(`${BUBBLE_BASE}/obj/user`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${BUBBLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Create failed for ${body.email}: ${res.status} ${err}`);
  }

  return res.json();
}

async function updateBubbleUser(bubbleId, changedFields) {
  const res = await fetch(`${BUBBLE_BASE}/obj/user/${bubbleId}`, {
    method:  'PATCH',
    headers: {
      Authorization:  `Bearer ${BUBBLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(changedFields),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Update failed for bubble id ${bubbleId}: ${res.status} ${err}`);
  }
}

// ── Diff ──────────────────────────────────────────────────────────────────────

function diffFields(atRecord, bubbleUser) {
  const f = atRecord.fields;
  const mapping = {
    'first name': (f['שם פרטי']  || '').trim(),
    'last name':  (f['שם משפחה'] || '').trim(),
    phone:        (f['טלפון']    || '').trim(),
    school:       (f['בית ספר']  || '').trim(),
    // email is a protected field in Bubble — cannot be updated via Data API
  };

  const changed = {};
  for (const [bubbleField, atValue] of Object.entries(mapping)) {
    const bubbleValue = (bubbleUser[bubbleField] || '').trim();
    if (atValue !== bubbleValue) {
      changed[bubbleField] = atValue;
    }
  }

  return Object.keys(changed).length > 0 ? changed : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('── Airtable → Bubble sync starting ──');

  const [atRecords, { byAirtableId, byEmail }] = await Promise.all([
    fetchAllAirtable(),
    fetchAllBubble(),
  ]);

  console.log(`Airtable records: ${atRecords.length}`);
  console.log(`Bubble users with airtable_record_id: ${byAirtableId.size}`);
  console.log(`Bubble users total (with email): ${byEmail.size}`);

  let created   = 0;
  let updated   = 0;
  let unchanged = 0;
  let errors    = 0;

  for (const record of atRecords) {
    const email = (record.fields['username'] || '').toLowerCase().trim();
    if (!email) {
      console.warn(`  ⚠ Skipping record ${record.id} — no email`);
      continue;
    }

    // Match by airtable_record_id first, fall back to email
    const bubbleUser = byAirtableId.get(record.id) || byEmail.get(email) || null;

    try {
      if (!bubbleUser) {
        await createBubbleUser(record);
        console.log(`  ✅ Created: ${email}`);
        created++;
      } else {
        // Always include airtable_record_id in diff so existing users get it set
        const diff = diffFields(record, bubbleUser);
        const needsIdUpdate = bubbleUser.airtable_record_id !== record.id;
        const changes = needsIdUpdate
          ? { ...(diff || {}), airtable_record_id: record.id }
          : diff;

        if (changes) {
          await updateBubbleUser(bubbleUser._id, changes);
          console.log(`  ✏️  Updated: ${email} — ${Object.keys(changes).join(', ')}`);
          updated++;
        } else {
          unchanged++;
        }
      }
    } catch (err) {
      // USED_EMAIL means a duplicate Airtable entry — skip gracefully
      if (err.message.includes('USED_EMAIL')) {
        console.warn(`  ⚠ Skipped duplicate email in Airtable: ${email}`);
        unchanged++;
      } else {
        console.error(`  ❌ Error (${email}): ${err.message}`);
        errors++;
      }
    }
  }

  console.log('');
  console.log(`── Summary ──`);
  console.log(`  Created:   ${created}`);
  console.log(`  Updated:   ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Errors:    ${errors}`);

  if (errors > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
