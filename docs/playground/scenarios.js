const names = {
  en: {
    description: 'Expense description',
    category: 'Category',
    amount: 'Amount (CNY)',
    date: 'Expense date',
    note: 'Notes',
    folder: 'Destination folder',
  },
  zh: {
    description: '报销事项',
    category: '费用类别',
    amount: '金额（元）',
    date: '费用日期',
    note: '备注',
    folder: '目标文件夹',
  },
};

export const scenarios = {
  expense: {
    title: { en: 'Expense drafts', zh: '报销单草稿' },
    brand: { en: 'Expense desk', zh: '费用工作台' },
    singular: { en: 'Expense draft', zh: '报销草稿' },
    action: { en: ['Save draft', 'Save changes'], zh: ['保存草稿', '保存更改'] },
    fields: ['description', 'category', 'amount', 'date', 'note'],
    common: ['category', 'amount', 'date'],
    variable: 'description',
    values: [
      'Train ticket to client meeting',
      'Hotel for team workshop',
      'Taxi to project review',
      'Office stationery',
      'Workshop lunch',
    ],
    defaults: { category: 'travel', amount: '128.50', date: '2026-11-10' },
  },
  invoice: {
    title: { en: 'Invoice downloads', zh: '订单发票下载' },
    brand: { en: 'Order desk', zh: '订单工作台' },
    singular: { en: 'Invoice', zh: '订单发票' },
    action: { en: ['Download invoice', 'Download PDF'], zh: ['下载发票', '下载 PDF'] },
    fields: ['orderId', 'amount'],
    common: [],
    variable: 'orderId',
    values: ['ORD-4101', 'ORD-4102', 'ORD-4103', 'ORD-4104', 'ORD-4105'],
    defaults: {},
  },
  mail: {
    title: { en: 'Email organization', zh: '邮箱整理' },
    brand: { en: 'Mail desk', zh: '邮箱工作台' },
    singular: { en: 'Message', zh: '邮件' },
    action: { en: ['Move message', 'File message'], zh: ['移动邮件', '整理邮件'] },
    fields: ['mailId', 'folder'],
    common: ['folder'],
    variable: 'mailId',
    values: ['MAIL-5101', 'MAIL-5102', 'MAIL-5103', 'MAIL-5104', 'MAIL-5105'],
    defaults: { folder: 'archive' },
  },
};

const options = {
  folder: [
    ['archive', 'Archive', '归档'],
    ['receipts', 'Receipts', '收据'],
    ['follow-up', 'Follow-up', '待跟进'],
  ],
  category: [
    ['travel', 'Travel', '差旅'],
    ['office', 'Office', '办公'],
    ['meals', 'Meals', '餐饮'],
  ],
};

export function label(field, language = 'en') {
  return names[language]?.[field] || names.en[field];
}

export function createField(field, language = 'en', prefix = 'business') {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const caption = document.createElement('label');
  caption.htmlFor = `${prefix}-${field}`;
  caption.textContent = label(field, language);
  const control = document.createElement(
    options[field] ? 'select' : field === 'note' ? 'textarea' : 'input',
  );
  control.id = caption.htmlFor;
  control.name = field;
  control.autocomplete = 'off';
  if (options[field]) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = language === 'zh' ? '请选择' : 'Choose one';
    control.append(empty);
    for (const [value, en, zh] of options[field]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = language === 'zh' ? zh : en;
      control.append(option);
    }
  } else if (control.tagName === 'INPUT') {
    control.type = field === 'amount' ? 'number' : field === 'date' ? 'date' : 'text';
    if (field === 'amount') {
      control.min = '0.01';
      control.step = '0.01';
    }
  } else {
    control.rows = 3;
  }
  control.required = field !== 'note';
  wrap.append(caption, control);
  return wrap;
}

export function readFields(form, scenario) {
  return Object.fromEntries(
    scenarios[scenario].fields.map((field) => {
      const input = form.elements.namedItem(field);
      return [field, input.value];
    }),
  );
}

export function makeBatch(scenario, common, values) {
  return values.map((value) => {
    const fields = { ...common, [scenarios[scenario].variable]: value };
    if (scenario === 'expense') fields.note = `Draft receipt: ${value}.`;
    if (scenario === 'invoice')
      fields.amount = invoiceOrders.find((order) => order.orderId === value)?.amount || '';
    return fields;
  });
}

export function mountBusinessForm(
  root,
  { scenario = 'expense', language = 'en', onSave, records = [] } = {},
) {
  const config = scenarios[scenario];
  const isZh = language === 'zh';
  root.replaceChildren();
  const head = document.createElement('div');
  head.className = 'business-heading';
  const brand = document.createElement('span');
  brand.className = 'business-brand';
  brand.textContent = config.brand[language];
  const title = document.createElement('h3');
  const subtitle = document.createElement('p');
  subtitle.className = 'business-subtitle';
  head.append(brand, title, subtitle);
  const form = document.createElement('form');
  form.className = 'business-form';
  const fields = document.createElement('fieldset');
  for (const field of config.fields) fields.append(createField(field, language));
  const actions = document.createElement('div');
  actions.className = 'business-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button button-primary';
  save.textContent = config.action[language][0];
  actions.append(save);
  form.append(fields, actions);
  const status = document.createElement('p');
  status.className = 'business-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const saved = document.createElement('div');
  saved.className = 'saved-records';
  root.append(head, form, status, saved);
  const savedRecords = [...records];
  title.textContent = config.singular[language];
  subtitle.textContent = isZh
    ? '仅保存演示草稿，不会发起付款。'
    : 'Demo drafts only. No payments are sent.';
  const renderRecords = () => {
    saved.replaceChildren();
    const header = document.createElement('div');
    header.className = 'saved-header';
    header.textContent = isZh
      ? `已保存 · ${savedRecords.length}`
      : `Saved · ${savedRecords.length}`;
    saved.append(header);
    for (const record of savedRecords.slice(-3).reverse()) {
      const row = document.createElement('div');
      row.className = 'saved-row';
      const marker = document.createElement('span');
      marker.className = 'saved-check';
      marker.textContent = '✓';
      const content = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = record.fields[config.variable];
      const detail = document.createElement('span');
      detail.textContent = `¥${record.fields.amount} · ${record.fields.category}`;
      content.append(name, detail);
      row.append(marker, content);
      saved.append(row);
    }
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const record = { id: crypto.randomUUID(), scenario, fields: readFields(form, scenario) };
    onSave?.(record);
    savedRecords.push(record);
    status.textContent = isZh ? '草稿已保存' : 'Draft saved';
    form.reset();
    renderRecords();
  });
  renderRecords();
  return { form, save };
}

export const invoiceOrders = [
  { orderId: 'ORD-4101', title: 'Design workshop', amount: '128.50' },
  { orderId: 'ORD-4102', title: 'Cloud storage', amount: '69.00' },
  { orderId: 'ORD-4103', title: 'Office supplies', amount: '215.80' },
  { orderId: 'ORD-4104', title: 'Team handbook', amount: '48.00' },
  { orderId: 'ORD-4105', title: 'Software subscription', amount: '159.00' },
];

export const mailMessages = [
  {
    id: 'MAIL-5101',
    subject: 'Workshop receipt',
    sender: 'billing@northstar.example.test',
    folder: 'inbox',
  },
  {
    id: 'MAIL-5102',
    subject: 'Project check-in',
    sender: 'team@cedar.example.test',
    folder: 'inbox',
  },
  {
    id: 'MAIL-5103',
    subject: 'Cloud invoice',
    sender: 'billing@harbor.example.test',
    folder: 'inbox',
  },
  {
    id: 'MAIL-5104',
    subject: 'Design review notes',
    sender: 'design@maple.example.test',
    folder: 'inbox',
  },
  {
    id: 'MAIL-5105',
    subject: 'Workshop schedule',
    sender: 'events@orbit.example.test',
    folder: 'inbox',
  },
];

export function invoicePdf(order) {
  // ASCII-only, uncompressed PDF: byte offsets equal string offsets.
  const lines = [
    'Synthetic Invoice',
    'Vendor: Example Workshop',
    `Order: ${order.orderId}`,
    order.title,
    `Amount: CNY ${order.amount}`,
    'Demo document - no payment due',
  ];
  const stream = `BT /F1 18 Tf 56 736 Td ${lines.map((line, index) => `${index ? '0 -36 Td ' : ''}(${line.replace(/[()\\]/g, '\\$&')}) Tj`).join('\n')} ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

export function mountItemDesk(
  root,
  { scenario, language = 'en', onSave, records = [], messages, onMessagesChange } = {},
) {
  const isZh = language === 'zh';
  const invoice = scenario === 'invoice';
  const config = scenarios[scenario];
  const items = invoice
    ? invoiceOrders
    : (messages || mailMessages).map((message) => ({ ...message }));
  let selected;
  let count = records.length;
  root.replaceChildren();
  const heading = document.createElement('div');
  heading.className = 'business-heading';
  const brand = document.createElement('span');
  brand.className = 'business-brand';
  brand.textContent = config.brand[language];
  const title = document.createElement('h3');
  title.textContent = invoice ? (isZh ? '你的订单' : 'Your orders') : isZh ? '收件箱' : 'Inbox';
  const subtitle = document.createElement('p');
  subtitle.className = 'business-subtitle';
  subtitle.textContent = invoice
    ? isZh
      ? '打开订单，下载虚构发票文件。'
      : 'Open an order to download its synthetic invoice.'
    : isZh
      ? '打开邮件，将它移入指定文件夹。'
      : 'Open a message and choose its destination folder.';
  heading.append(brand, title, subtitle);
  const list = document.createElement('div');
  list.className = 'business-item-list';
  const detail = document.createElement('section');
  detail.className = 'business-detail';
  detail.hidden = true;
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'text-button';
  back.textContent = isZh ? '← 返回列表' : '← Back to list';
  const detailTitle = document.createElement('h4');
  const detailText = document.createElement('p');
  const detailExtra = document.createElement('p');
  detailExtra.className = 'detail-extra';
  let folder;
  if (!invoice) {
    const field = createField('folder', language, 'message');
    folder = field.querySelector('select');
    folder.value = 'archive';
    detail.append(back, detailTitle, detailText, detailExtra, field);
  } else detail.append(back, detailTitle, detailText, detailExtra);
  const action = document.createElement('button');
  action.type = 'button';
  action.name = invoice ? 'download-invoice' : 'move-message';
  action.className = 'button button-primary';
  action.textContent = config.action[language][0];
  detail.append(action);
  const status = document.createElement('p');
  status.className = 'business-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const summary = document.createElement('div');
  summary.className = 'desk-summary';
  const renderList = () => {
    list.replaceChildren();
    for (const item of items) {
      const itemId = invoice ? item.orderId : item.id;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'business-item';
      const name = document.createElement('strong');
      name.textContent = itemId;
      const description = document.createElement('span');
      description.id = `item-${itemId}-description`;
      description.textContent = invoice ? item.title : item.subject;
      const meta = document.createElement('small');
      meta.id = `item-${itemId}-status`;
      meta.textContent = invoice ? `CNY ${item.amount}` : item.folder;
      button.setAttribute('aria-label', itemId);
      button.setAttribute('aria-describedby', `${description.id} ${meta.id}`);
      button.append(name, description, meta);
      button.addEventListener('click', () => {
        selected = item;
        list.hidden = true;
        detail.hidden = false;
        detailTitle.textContent = invoice ? item.orderId : item.subject;
        detailText.textContent = invoice ? item.title : item.sender;
        detailExtra.textContent = invoice ? `CNY ${item.amount}` : `${item.id} · ${item.folder}`;
      });
      list.append(button);
    }
    summary.textContent = invoice
      ? isZh
        ? `已下载 ${count} 份发票`
        : `${count} invoices downloaded`
      : isZh
        ? `已整理 ${count} 封邮件`
        : `${count} messages organized`;
  };
  const showList = () => {
    list.hidden = false;
    detail.hidden = true;
    renderList();
  };
  back.addEventListener('click', showList);
  action.addEventListener('click', () => {
    if (!selected || (!invoice && !folder.reportValidity())) return;
    const fields = invoice
      ? { orderId: selected.orderId, amount: selected.amount }
      : { mailId: selected.id, folder: folder.value };
    if (invoice) {
      const url = URL.createObjectURL(
        new Blob([invoicePdf(selected)], { type: 'application/pdf' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `invoice-${selected.orderId}.pdf`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      selected.folder = folder.value;
      onMessagesChange?.(items);
    }
    const record = { id: crypto.randomUUID(), scenario, fields };
    onSave?.(record);
    count++;
    status.textContent = invoice
      ? isZh
        ? `${selected.orderId} · 发票已下载`
        : `${selected.orderId} · Invoice downloaded`
      : isZh
        ? `${selected.id} · 已移至 ${folder.value}`
        : `${selected.id} · Moved to ${folder.value}`;
    showList();
  });
  root.append(heading, list, detail, status, summary);
  renderList();
  return {
    action,
    folder,
    choose(id) {
      const index = items.findIndex((item) => (invoice ? item.orderId : item.id) === id);
      if (index < 0) throw new Error('Item not found');
      list.children[index].click();
    },
  };
}
