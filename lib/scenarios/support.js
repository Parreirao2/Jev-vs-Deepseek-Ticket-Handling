// Scenario: customer support ticket triage.
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const maybe = (p) => Math.random() < p;
const orderNum = () => Math.floor(10000 + Math.random() * 89999);

const names = [
  'Alex', 'Priya', 'Jordan', 'Sam', 'Maria', 'Chen', 'Liam', 'Nina', 'Omar', 'Fatima',
  'Jake', 'Elena', 'Tariq', 'Grace', 'Noah', 'Ines', 'Marco', 'Yuki', 'Diego', 'Hannah',
];

const issuesByCategory = {
  billing: {
    products: ['my subscription', 'the annual plan', 'my invoice', 'the Pro plan', 'my last payment'],
    issues: [
      "I was charged twice for {product}",
      "{product} renewed but I cancelled it last month",
      "I can't find a receipt for {product}",
      "The price for {product} changed without any notice",
      "My card was declined but you still charged me for {product}",
      "I need a refund for {product}, it was a mistake",
      "Can you explain the extra line item on {product}?",
      "I'm being billed in the wrong currency for {product}",
    ],
  },
  technical: {
    products: ['the dashboard', 'the mobile app', 'the API', 'the export feature', 'the login page', 'the sync feature'],
    issues: [
      "{product} keeps crashing when I try to save",
      "{product} has been throwing a 500 error since this morning",
      "I can't get {product} to load at all, just a blank screen",
      "{product} is running extremely slowly today",
      "Getting error code E-4471 on {product}",
      "{product} lost all my data after the last update",
      "{product} won't sync across my devices anymore",
      "Uploading a file to {product} fails every time",
    ],
  },
  account: {
    products: ['my account', 'two-factor authentication', 'my email on file', 'my password', 'my username'],
    issues: [
      "I'm locked out of {product} and the reset link isn't working",
      "Someone else seems to have access to {product}",
      "I need to change {product} but the form keeps failing",
      "I never got the verification code for {product}",
      "Can you merge two accounts under {product}?",
      "I want to delete {product} and all my data permanently",
      "{product} shows the wrong plan tier",
    ],
  },
  shipping: {
    products: ['order #{order}', 'my replacement item', 'my return', 'the package', 'my exchange'],
    issues: [
      "{product} was marked delivered but never arrived",
      "{product} arrived damaged, the box was crushed",
      "I still haven't received {product} after 3 weeks",
      "{product} shows the wrong tracking number",
      "I need to change the address for {product} before it ships",
      "{product} came with the wrong item inside",
      "Can you speed up {product}? I need it by Friday",
      "I sent {product} back two weeks ago, still no refund",
    ],
  },
  general: {
    products: ['your pricing page', 'the enterprise plan', 'a partnership', 'your API docs', 'the onboarding call'],
    issues: [
      "Do you offer student discounts on {product}?",
      "I'd like to ask about {product} before I commit",
      "Are you hiring? I saw a role related to {product}",
      "Just wanted to say the support on {product} was great",
      "Can someone walk me through {product}?",
      "What are your hours for support on {product}?",
      "I'm writing a comparison article, can I ask about {product}?",
    ],
  },
};

const urgentPrefixes = ['URGENT: ', 'Please help ASAP - ', 'This is time-sensitive: ', 'Escalating this - ', ''];
const angryClosers = [
  " This is the third time I've reported this.",
  " I'm honestly about to cancel if this isn't fixed today.",
  ' Completely unacceptable for a paid plan.',
  '',
  '',
];
const politeClosers = [
  ' Thanks so much for your help!',
  ' No rush, whenever you get a chance.',
  ' Appreciate it in advance.',
  '',
  '',
];
const vagueItems = [
  "It's broken. Please fix.",
  'Still waiting on this...',
  'Hey, quick question.',
  'Not working.',
  'Any update?',
  '??',
  'Same issue as before I guess',
];

// A handful of Portuguese/Spanish tickets mixed in, to show Jev classifies
// correctly regardless of the language a ticket is written in.
const multilingualItems = [
  'Fui cobrado duas vezes pela mensalidade, podem verificar?',
  'A fatura deste mês tem um valor estranho que não reconheço.',
  'O aplicativo está a fechar sozinho sempre que tento guardar.',
  'Não consigo aceder ao painel, aparece uma página em branco.',
  'Esqueci-me da password e o link de recuperação não chega ao meu email.',
  'Alguém tentou aceder à minha conta, podem verificar a segurança?',
  'A minha encomenda ainda não chegou e já passaram duas semanas.',
  'O produto veio danificado, a caixa estava toda amassada.',
  'Vocês têm desconto para estudantes?',
  'Só queria agradecer, o suporte foi excelente ontem.',
  'URGENTE: o sistema caiu completamente, não conseguimos trabalhar.',
  'Preciso de apagar a minha conta e todos os meus dados.',
  'Me cobraron dos veces la suscripción, necesito un reembolso.',
  'La aplicación se congela cada vez que intento subir un archivo.',
  'No recibí el código de verificación para entrar a mi cuenta.',
  'Mi pedido llegó incompleto, faltaba un artículo.',
  '¿Tienen planes para empresas grandes?',
  'URGENTE: el sitio lleva caído toda la mañana.',
  'Necesito cambiar la dirección de envío antes de que salga el paquete.',
  'Gracias por la ayuda tan rápida, excelente servicio.',
];

function makeItem(category) {
  const meta = issuesByCategory[category];
  const product = rand(meta.products).replace('{order}', orderNum());
  const issue = rand(meta.issues).replace('{product}', product);
  const name = rand(names);
  const urgent = maybe(0.22);
  const angry = urgent && maybe(0.6);
  let text = `${urgent ? rand(urgentPrefixes) : ''}Hi, ${name} here. ${issue}.`;
  if (angry) text += rand(angryClosers);
  else if (maybe(0.4)) text += rand(politeClosers);
  return text.trim();
}

function generate(count = 150) {
  const categoryKeys = Object.keys(issuesByCategory);
  const items = [];
  const perCategory = Math.floor((count - vagueItems.length - multilingualItems.length) / categoryKeys.length);
  for (const category of categoryKeys) {
    for (let i = 0; i < perCategory; i++) items.push({ text: makeItem(category) });
  }
  for (const v of vagueItems) items.push({ text: v });
  for (const m of multilingualItems) items.push({ text: m });
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
  key: 'support',
  label: 'Customer support',
  description: 'Triage of support tickets by department, urgency, and suggested reply',
  itemNoun: { singular: 'ticket', plural: 'tickets' },
  inputPlaceholder: 'Type a support ticket and watch Jev classify it instantly...',

  categories: [
    { key: 'billing', label: 'Billing', color: '#f5a623', criteria: 'Charges, invoices, refunds, pricing, payment methods' },
    { key: 'technical', label: 'Technical', color: '#4a90d9', criteria: 'Bugs, errors, crashes, performance, app or API not working' },
    { key: 'account', label: 'Account', color: '#9b59b6', criteria: 'Login, password, 2FA, account access, account settings' },
    { key: 'shipping', label: 'Shipping & Returns', color: '#2ecc71', criteria: 'Orders, delivery, tracking, returns, exchanges, damaged items' },
    { key: 'general', label: 'General', color: '#8b93a7', criteria: 'Sales questions, pricing info, partnerships, general inquiries, compliments' },
  ],
  categoryQuestion: { instructions: 'Which team should handle this support ticket?' },

  severityQuestion: {
    label: 'Urgency',
    instructions: 'How severe or urgent is this ticket for the customer?',
    criteria: [
      'Cosmetic or minor question, no real impact',
      'Annoying but has a workaround',
      'Blocking the customer from normal use',
      'Critical: outage, data loss, or very angry/urgent tone',
    ],
  },
  slaHoursBySeverity: [72, 24, 4, 1],

  humanQuestion: {
    label: 'Needs human',
    instructions: 'Does this ticket need a personal, empathetic reply from a human rather than a templated automated response?',
  },

  actionQuestion: {
    label: 'Suggested reply',
    instructions: 'Which canned reply template should an agent use as the starting point for responding to this ticket? Only pick a specific template if it genuinely fits; otherwise pick none.',
    noneCriteria: "Doesn't clearly match any of the other templates, is too vague to act on, or mixes multiple unrelated issues",
  },
  actions: [
    {
      key: 'billing_refund',
      label: 'Refund confirmation',
      criteria: 'Customer was overcharged, double-charged, or is owed a refund',
      body: "Hi there, thanks for flagging this — we've confirmed the charge was an error and processed a full refund to your original payment method. It should land within 3-5 business days. Sorry for the trouble!",
    },
    {
      key: 'billing_invoice_explainer',
      label: 'Invoice / pricing explainer',
      criteria: 'Customer has a question about a charge, invoice line item, or a pricing change',
      body: "Hi there, happy to clarify — here's a breakdown of that charge on your account. Let us know if anything still looks off and we'll dig deeper.",
    },
    {
      key: 'technical_known_issue',
      label: 'Known issue with workaround',
      criteria: 'A bug, crash, or error that has a workaround available and is not a full outage',
      body: "Hi there, thanks for reporting this — we're aware of the issue and there's a workaround in the meantime: [steps]. Our team is also working on a permanent fix.",
    },
    {
      key: 'technical_outage',
      label: 'Outage acknowledgement',
      criteria: 'A critical outage, total failure, or data loss with major impact',
      body: "Hi there, we're really sorry — our team is actively investigating this and treating it as top priority. We'll update you as soon as it's resolved.",
    },
    {
      key: 'account_reset_help',
      label: 'Password / 2FA reset help',
      criteria: 'Customer is locked out, needs a password reset, or never received a verification code',
      body: "Hi there, let's get you back in — I've triggered a new reset link to your account email, it should arrive within a few minutes.",
    },
    {
      key: 'account_access_review',
      label: 'Account security review',
      criteria: 'Suspicious account access, unauthorized changes, or an account deletion request',
      body: "Hi there, thanks for flagging this — we've reviewed your account activity and locked things down as a precaution. Please reset your password to regain full access.",
    },
    {
      key: 'shipping_replacement',
      label: 'Replacement for damaged/lost item',
      criteria: 'An item arrived damaged, never arrived, or the wrong item was sent',
      body: "Hi there, so sorry about that! We're sending a free replacement right away, no need to return the original — tracking will follow shortly.",
    },
    {
      key: 'shipping_status_update',
      label: 'Order status / tracking update',
      criteria: 'Customer is asking about delivery timing, tracking, or an address change before shipment',
      body: "Hi there, thanks for your patience — here's the latest tracking status on your order, and we've flagged it for priority handling.",
    },
    {
      key: 'general_info',
      label: 'General info / FAQ answer',
      criteria: 'A general question about pricing, hours, features, partnerships, or how something works',
      body: "Hi there, thanks for reaching out! Here's the info you're looking for: [answer]. Let us know if you have any other questions.",
    },
    {
      key: 'general_thanks',
      label: 'Thank-you acknowledgement',
      criteria: 'A genuine compliment or thank-you message with no issue to resolve',
      body: "Hi there, thank you so much for reaching out — really appreciate you taking the time to share this with us!",
    },
  ],

  agentNoun: { singular: 'agent', plural: 'agents' },
  agents: {
    billing: ['Beatriz', 'Rui'],
    technical: ['Sofia', 'André'],
    account: ['Carla', 'Tiago'],
    shipping: ['Rita', 'Pedro'],
    general: ['Sara', 'Bruno'],
  },

  generate,
};
