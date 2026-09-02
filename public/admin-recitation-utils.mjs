function text(value) {
  return String(value ?? '').trim();
}

function compareText(left, right) {
  return text(left).localeCompare(text(right), 'en', { sensitivity: 'base', numeric: true });
}

function balance(row) {
  const value = Number(row?.balance);
  return Number.isFinite(value) ? value : 0;
}

export function filterAndSortWallets(rows, options = {}) {
  const status = options.status || 'all';
  const sort = options.sort || 'name_asc';
  const filtered = [...rows].filter((row) => {
    if (status === 'protected') return Boolean(row.pin_set);
    if (status === 'unprotected') return !row.pin_set;
    if (status === 'negative') return balance(row) < 0;
    if (status === 'zero') return balance(row) === 0;
    return true;
  });

  const byName = (left, right) => compareText(left.full_name, right.full_name)
    || compareText(left.student_no, right.student_no);
  const comparators = {
    name_asc: byName,
    name_desc: (left, right) => byName(right, left),
    balance_desc: (left, right) => balance(right) - balance(left) || byName(left, right),
    balance_asc: (left, right) => balance(left) - balance(right) || byName(left, right),
    section: (left, right) => compareText(left.section, right.section) || byName(left, right),
  };

  return filtered.sort(comparators[sort] || comparators.name_asc);
}

export function filterAndSortLedger(rows, options = {}) {
  const query = text(options.query).toLocaleLowerCase('en');
  const sort = options.sort || 'newest';
  const filtered = [...rows].filter((row) => {
    if (!query) return true;
    return [row.transaction_type, row.from_name, row.to_name, row.section, row.subject_code, row.note]
      .some((value) => text(value).toLocaleLowerCase('en').includes(query));
  });

  const time = (row) => {
    const value = new Date(row?.created_at).getTime();
    return Number.isFinite(value) ? value : 0;
  };
  const amount = (row) => {
    const value = Number(row?.amount);
    return Number.isFinite(value) ? value : 0;
  };
  const stable = (left, right) => compareText(left.to_name, right.to_name)
    || compareText(left.from_name, right.from_name);
  const comparators = {
    newest: (left, right) => time(right) - time(left) || stable(left, right),
    oldest: (left, right) => time(left) - time(right) || stable(left, right),
    amount_desc: (left, right) => amount(right) - amount(left) || time(right) - time(left),
    amount_asc: (left, right) => amount(left) - amount(right) || time(right) - time(left),
  };

  return filtered.sort(comparators[sort] || comparators.newest);
}
