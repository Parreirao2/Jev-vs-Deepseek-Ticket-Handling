// Scenario: user-generated content moderation (comments/reviews).
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

const products = ['the app', 'the new update', 'your support team', 'the checkout flow', 'the mobile experience', 'this platform'];

const templatesByCategory = {
  spam: [
    'MAKE $5000/WEEK FROM HOME! No experience needed, click the link in my profile now!!!',
    'Check out my page for FREE followers and likes, link in bio, limited time offer!!!',
    'Congratulations, you have been selected for a special prize, claim it here before it expires!!!',
    'Buy cheap followers and views instantly, DM me now for the best rates!!!',
  ],
  harassment: [
    "Whoever built this is clearly incompetent, you should all be ashamed of yourselves.",
    "This is the dumbest thing I have ever used, the people behind it must be idiots.",
    "Absolutely pathetic excuse for a product, fire whoever approved this garbage.",
    "You people clearly don't care about your users at all, useless company.",
  ],
  genuine_negative: [
    'Really disappointed, {product} crashed three times during my presentation today.',
    "Not happy with {product} lately, it's noticeably slower than it used to be.",
    "I've had two bad experiences with {product} this month, hoping it gets better.",
    "Honestly expected more from {product} for the price we're paying.",
  ],
  genuine_positive: [
    '{product} genuinely saved us hours every week, really impressed.',
    'Just wanted to say {product} has been great, the team clearly cares.',
    'Been using {product} for months now and it keeps getting better, well done.',
    'Support helped me out today in minutes, {product} experience overall has been excellent.',
  ],
  off_topic: [
    'Does anyone know a good recipe for banana bread?',
    'What time zone is this forum on?',
    'Random question, anyone else watching the game tonight?',
    'Testing testing, is this thing on?',
  ],
};

function makeItem(category) {
  return rand(templatesByCategory[category]).replace('{product}', rand(products));
}

function generate(count = 150) {
  const categoryKeys = Object.keys(templatesByCategory);
  const items = [];
  const perCategory = Math.floor(count / categoryKeys.length);
  for (const category of categoryKeys) {
    for (let i = 0; i < perCategory; i++) items.push({ text: makeItem(category) });
  }
  while (items.length < count) items.push({ text: makeItem(rand(categoryKeys)) });
  items.length = count;

  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  items.forEach((it, i) => (it.id = i + 1));
  return items;
}

module.exports = {
  key: 'moderation',
  label: 'Content moderation',
  description: 'Triage of comments and reviews by violation type and recommended action',
  itemNoun: { singular: 'comment', plural: 'comments' },
  inputPlaceholder: 'Type a comment/review and watch Jev moderate it instantly...',

  categories: [
    { key: 'spam', label: 'Spam', color: '#f5a623', criteria: 'Unsolicited advertising, bot-like repetitive content, or scam links' },
    { key: 'harassment', label: 'Harassment/Abuse', color: '#ef4444', criteria: 'Personal attacks, insults, threats, or hate speech directed at people or the company' },
    { key: 'genuine_negative', label: 'Genuine Complaint', color: '#f97316', criteria: 'A real negative review or complaint about the product/service, without abusive language' },
    { key: 'genuine_positive', label: 'Genuine Positive', color: '#2ecc71', criteria: 'A real positive review or compliment about the product/service' },
    { key: 'off_topic', label: 'Off-topic', color: '#8b93a7', criteria: "Doesn't relate to the product/service at all, or is unclear noise" },
  ],
  categoryQuestion: { instructions: 'What kind of content is this comment/review?' },

  severityQuestion: {
    label: 'Risk level',
    instructions: 'How much of a guideline violation or harm risk does this content pose?',
    criteria: [
      'No real harm, can stay up as-is',
      'Mildly negative or low-quality but not harmful',
      'Clearly violates guidelines, should be actioned',
      'Severe violation — harassment, threats, or hate speech, urgent removal',
    ],
  },
  slaHoursBySeverity: [72, 24, 4, 1],

  humanQuestion: {
    label: 'Needs human moderator',
    instructions: 'Does this content need a human moderator to review it personally rather than being auto-actioned?',
  },

  actionQuestion: {
    label: 'Recommended action',
    instructions: 'Which moderation action fits this content? Only pick a specific action if it genuinely fits; otherwise pick none.',
    noneCriteria: "Doesn't clearly match any of the other actions, or the content is too ambiguous to auto-action",
  },
  actions: [
    {
      key: 'auto_approve',
      label: 'Approve, no action',
      criteria: 'Genuine, non-violating content that can stay up as-is',
      body: 'No action needed — content approved automatically.',
    },
    {
      key: 'remove_spam',
      label: 'Remove as spam',
      criteria: 'Spam or scam content that should be removed automatically',
      body: 'Content removed automatically for violating spam guidelines.',
    },
    {
      key: 'warn_and_remove',
      label: 'Remove & warn user',
      criteria: 'A moderate guideline violation that should be removed with a warning to the user',
      body: 'Content removed and the user has been sent a warning about our community guidelines.',
    },
    {
      key: 'escalate_trust_safety',
      label: 'Escalate to Trust & Safety',
      criteria: 'Severe violation (harassment, threats, hate speech) needing urgent human review',
      body: 'Escalated immediately to the Trust & Safety team for urgent human review.',
    },
    {
      key: 'respond_to_complaint',
      label: 'Flag for support follow-up',
      criteria: 'A genuine negative review or complaint that support should personally follow up on',
      body: 'Flagged for the support team to personally follow up with this customer.',
    },
    {
      key: 'thank_positive',
      label: 'Acknowledge positive review',
      criteria: 'A genuine positive review or compliment worth acknowledging',
      body: 'Thanks for the kind words — flagged to share with the team!',
    },
  ],

  agentNoun: { singular: 'moderator', plural: 'moderators' },
  agents: {
    spam: ['Beatriz', 'Rui'],
    harassment: ['Sofia', 'André'],
    genuine_negative: ['Carla', 'Tiago'],
    genuine_positive: ['Rita', 'Pedro'],
    off_topic: ['Sara', 'Bruno'],
  },

  generate,
};
