// Rain behind the wordmark: thin streaks at random spots, lengths and speeds.
(function makeRain() {
	const rain = document.getElementById("rain");
	const count = window.innerWidth < 640 ? 28 : 60;

	for (let i = 0; i < count; i++) {
		const drop = document.createElement("i");
		drop.style.left = `${Math.random() * 100}%`;
		drop.style.height = `${40 + Math.random() * 90}px`;
		drop.style.opacity = (0.25 + Math.random() * 0.6).toFixed(2);
		drop.style.animationDuration = `${1.1 + Math.random() * 1.6}s`;
		drop.style.animationDelay = `${-Math.random() * 3}s`;
		drop.style.top = `${-20 + Math.random() * 100}vh`;
		rain.appendChild(drop);
	}
})();

if (new URLSearchParams(location.search).get("login") === "failed") {
	document.getElementById("loginFailed").hidden = false;
}

// Already signed in? Offer the dashboard instead of the sign-in button.
fetch("/api/me")
	.then((response) => response.json())
	.then((data) => {
		if (data.user) {
			document.getElementById("signIn").hidden = true;
			document.getElementById("openLicense").hidden = false;
		}
	})
	.catch(() => {});
