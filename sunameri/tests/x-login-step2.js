// X ログインモーダル: ユーザー名を入力して Continue を押す(ダミーのユーザー名)
(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
  const inp = document.querySelector("#jf-input-username_or_email, input[autocomplete^=username]");
  console.log("[step2] input=" + (inp ? inp.outerHTML.slice(0, 120) : "none"));
  if (!inp) return;
  const setter = Object.getOwnPropertyDescriptor(Element.prototype, "value").set;
  inp.focus();
  setter.call(inp, "sunameri_test_user_404");
  inp.dispatchEvent(new InputEvent("input", { bubbles: true, data: "s", inputType: "insertText" }));
  inp.dispatchEvent(new Event("change", { bubbles: true }));
  setTimeout(() => {
    const btns = [...document.querySelectorAll("button")];
    console.log("[step2] buttons=" + JSON.stringify(btns.map((b) => text(b).slice(0, 25) + (b.disabled ? "(disabled)" : ""))));
    const btn = btns.find((b) => /^(Continue|次へ)$/.test(text(b)) && !b.disabled);
    console.log("[step2] clicking=" + (btn ? btn.outerHTML.slice(0, 100) : "none"));
    if (btn) btn.click();
    setTimeout(() => {
      console.log("[step2] after: " + JSON.stringify((document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400)));
    }, 6000);
  }, 1500);
})();
