import { get } from './api.js';
import { $, renderList, show } from './ui.js';
import { mountNav } from './nav.js';

await mountNav('/recommend');

try {
  const data = await get('/api/recommendations?limit=20');
  if (data.basis === 'cold_start') {
    show(
      $('#msg'),
      data.message || 'Hãy thích vài ý tưởng để gợi ý bám sát gu của bạn hơn.',
      'note',
    );
  } else {
    show(
      $('#msg'),
      `Dựa trên ${data.source_count} ý tưởng bạn đã thích.`,
      'ok',
    );
  }
  renderList(
    $('#list'),
    data.items,
    'Chưa có gì để gợi ý. Hãy thêm ý tưởng và thích vài cái bạn tâm đắc.',
  );
} catch (err) {
  show($('#msg'), err.message);
  $('#list').innerHTML = '';
}
