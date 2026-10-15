// Shared handler for the apply and request-a-bid forms.
// Sends the form as JSON to the endpoint in data-endpoint and shows success / error.
(function () {
  var form = document.querySelector('form[data-endpoint]');
  if (!form) return;

  var started = Date.now();
  var status = document.getElementById('form-status');
  var success = document.getElementById('form-success');
  var button = form.querySelector('button[type=submit]');
  var buttonText = button.textContent;

  function collect() {
    var data = {};
    var fd = new FormData(form);
    fd.forEach(function (value, key) {
      var multi = form.querySelectorAll('[name="' + key + '"]').length > 1 &&
                  form.querySelector('[name="' + key + '"]').type === 'checkbox';
      if (multi) {
        (data[key] = data[key] || []).push(value);
      } else {
        data[key] = typeof value === 'string' ? value.trim() : value;
      }
    });
    // Single checkboxes that are unchecked are sent as false
    form.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      var group = form.querySelectorAll('[name="' + cb.name + '"]').length > 1;
      if (!group) data[cb.name] = cb.checked;
    });
    data._elapsed_ms = Date.now() - started;
    return data;
  }

  function showError(msg) {
    status.className = 'form-status error';
    status.innerHTML = msg;
    status.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    status.className = 'form-status';
    status.textContent = '';

    // Require at least one box in required checkbox groups
    var groups = form.querySelectorAll('[data-require-one]');
    for (var i = 0; i < groups.length; i++) {
      if (!groups[i].querySelector('input:checked')) {
        showError('Please pick at least one option under “' + groups[i].getAttribute('data-require-one') + '.”');
        return;
      }
    }

    button.disabled = true;
    button.textContent = 'Sending…';

    fetch(form.getAttribute('data-endpoint'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collect())
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok || !body.ok) throw new Error(body.error || 'Request failed');
          form.style.display = 'none';
          success.classList.add('show');
          success.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      })
      .catch(function (err) {
        var detail = err && err.message && err.message !== 'Request failed' && err.message !== 'Failed to fetch'
          ? ' (' + err.message + ')' : '';
        showError('We couldn’t send your form' + detail + '. Please try again, or email us at <a href="mailto:info@linelite.net">info@linelite.net</a>.');
        button.disabled = false;
        button.textContent = buttonText;
      });
  });
})();
