import { api, app, can, state, esc, pill, shortDate, today, toast, openSheet, closeSheet, val, field, selectField, loadReference } from '../core.js';

export const routes = {
  operations: {
    title: 'Operations',
    permission: 'tasks:read',
    async render() {
      const tasks = await api('/tasks');
      const write = can('tasks:write');
      const cols = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
      return `
        <div class="head"><h1>Operations</h1><p>Today's jobs and who is on them</p>
          <div class="spacer"></div>${write ? '<button class="solid" data-act="new-task">Add job</button>' : ''}</div>
        <div class="board">
          ${cols.map(([key, label]) => {
            const inCol = tasks.filter((t) => t.status === key);
            return `<section class="col" aria-labelledby="col-${key}"><h2 id="col-${key}">${label} · ${inCol.length}</h2>
              ${inCol.length ? `<ul>${inCol.map((t) => {
                const late = t.status !== 'done' && t.dueDate && t.dueDate <= today();
                return `<li>
                <div class="t">${esc(t.title)}</div>
                <div class="m">
                  ${pill(t.priority)}
                  <span class="num ${late ? 'late' : ''}">${late ? '<span class="sr-only">Late, due </span>' : ''}${shortDate(t.dueDate)}</span>
                  ${t.assignee ? `<span>${esc(t.assignee)}</span>` : ''}
                  ${t.clientName ? `<span>· ${esc(t.clientName)}</span>` : ''}
                  ${write && key !== 'done' ? `<button class="link" data-act="task-move" data-id="${esc(t.id)}" data-status="${key === 'todo' ? 'doing' : 'done'}" aria-label="${key === 'todo' ? 'Start' : 'Finish'}: ${esc(t.title)}">${key === 'todo' ? 'Start' : 'Finish'}</button>` : ''}
                  ${write && key === 'done' ? `<button class="link" data-act="task-move" data-id="${esc(t.id)}" data-status="doing" aria-label="Reopen: ${esc(t.title)}">Reopen</button>` : ''}
                  ${write ? `<button class="link danger" data-act="del-task" data-id="${esc(t.id)}" aria-label="Delete: ${esc(t.title)}">Delete</button>` : ''}
                </div></li>`;
              }).join('')}</ul>`
              : `<p class="none">${key === 'todo' ? 'Nothing queued.' : key === 'doing' ? 'Nothing in progress.' : 'Nothing finished yet.'}</p>`}
            </section>`;
          }).join('')}
        </div>`;
    }
  }
};

export const actions = {
  'new-task': async () => {
    await loadReference();
    openSheet('Add job', `
      ${field('What needs doing', 'title', { attrs: 'placeholder="Deliver 20 drums to Industrial Area"' })}
      <div class="row">
        ${field('Who is on it', 'assignee')}
        ${field('Due', 'dueDate', { type: 'date', value: today() })}
      </div>
      <div class="row">
        ${selectField('Priority', 'priority', [['normal', 'Normal'], ['high', 'High'], ['low', 'Low']], 'normal')}
        ${selectField('For client (optional)', 'clientId', [['', '—'], ...state.clients.map((c) => [c.id, c.name])], '')}
      </div>`,
    async () => {
      await api('/tasks', 'POST', { title: val('title'), assignee: val('assignee'), dueDate: val('dueDate'), priority: val('priority'), clientId: val('clientId') || null });
      closeSheet();
      toast('Job added.');
      app.render();
    }, 'Add job');
  },

  'task-move': async (el) => {
    await api(`/tasks/${el.dataset.id}`, 'PUT', { status: el.dataset.status });
    app.render();
  },

  'del-task': async (el) => {
    if (!confirm('Delete this job?')) return;
    await api(`/tasks/${el.dataset.id}`, 'DELETE');
    toast('Job deleted.');
    app.render();
  }
};
