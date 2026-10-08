// User-controlled text (client names, task titles, workspace names) goes into email HTML only
// through this, so it can never inject markup into mail sent from Clientglass's address.
module.exports = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
