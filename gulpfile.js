const fs = require('fs').promises;
const { parallel } = require('gulp');
const captureWebsite = require('capture-website');
const path = require('path');
const { JSDOM } = require('jsdom');

const DEBUG = 0;

/**
 * @type {Object<string, ThemesEntry>}
 *
 * @typedef ThemesEntry
 * @property {string} title
 * @property {Entity} owner
 * @property {Entity} [originalOwner]
 * @property {Entity} [basedOn]
 *
 * @typedef {string | { name: string; link?: string }} Entity
 */
const themeCatalog = require('./themes.json').themes;

const themesDir = path.join(__dirname, 'themes');
const screenshotDir = path.join(__dirname, 'screenshots');
const getThemePath = theme => path.join(themesDir, `prism-${theme}.css`);
const getScreenshotPath = theme => path.join(screenshotDir, `prism-${theme}.png`);

/**
 * Returns the names of all themes. This includes the `prism-` prefix.
 */
async function getThemes(fromScratch) {
	let themes = (!fromScratch ? themeCatalog : null) || {};
	let change = await discoverThemes(themes, !fromScratch);
	let keys = Object.keys(themes).sort((a, b) => {
		return a.localeCompare(b, {
			ignorePunctuation: true,
			caseFirst: "upper",
			sensitivity: "base",
			usage: "sort",
		});
	});
	
	// re-order themes before (re)writing:
	let rv = {};
	for (const i in keys) {
		const key = keys[i];
		const theme = themes[key];
		rv[key] = theme;
	}
	//let change = true;
	themes = rv;

	if (change) {
		await fs.writeFile('./themes.json', JSON.stringify({themes}, null, 4), 'utf-8');
	}
	return keys;
}

/**
 * Takes a screenshot of all themes overwriting the old ones.
 */
async function screenshotAllThemes() {
	for (const theme of await getThemes()) {
		await screenshotTheme(theme, true);
	}
}

/**
 * Takes a screenshot of themes which don't have one already.
 */
async function screenshotMissingThemes() {
	for (const theme of await getThemes()) {
		await screenshotTheme(theme, false);
	}
}

/**
 * Takes a screenshot of the given themes and saves the image file in the screenshot directory.
 *
 * __IMPORTANT:__ Screenshots have to be taken sequentially, one after an other, to prevent a memory leak.
 *
 * @param {string} theme
 * @param {boolean} overwrite
 */
async function screenshotTheme(theme, overwrite) {
	const file = getScreenshotPath(theme);

	if (await fs.stat(file).then(s => s.isFile()).catch(() => false)) {
		if (overwrite) {
			await fs.unlink(file);
		} else {
			return;
		}
	}

	await captureWebsite.file(screenshotDir + '/code.html', file, {
		defaultBackground: false,
		scaleFactor: 1,
		element: 'pre',
		styles: [
			await fs.readFile(getThemePath(theme), 'utf-8')
		]
	});
}

/**
 * Updates the "Available themes" section in `README.md`.
 */
async function updateReadme() {
	const themes = await getThemes();

	/**
	 * Returns the credit string of a theme.
	 *
	 * @param {ThemesEntry} entry
	 * @returns {string}
	 */
	function getCredit(entry) {
		if (entry.basedOn) {
			return `by ${printEntity(entry.owner)}, based on ${printEntity(entry.basedOn)}`;
		} else if (entry.originalOwner) {
			return `originally by ${printEntity(entry.originalOwner)}, adapted by ${printEntity(entry.owner)}`;
		} else {
			return `by ${printEntity(entry.owner)}`;
		}
	}
	/**
	 * @param {Entity} entity
	 */
	function printEntity(entity) {
		if (typeof entity === 'string') {
			return `[${entity}](https://github.com/${entity})`;
		} else if (entity.link) {
			return `[${entity.name}](${entity.link})`;
		} else {
			return entity.name;
		}
	}

	const md = themes.map(theme => {
		const css = `themes/prism-${theme}.css`;
		const screenshot = `screenshots/prism-${theme}.png`;

		const entry = themeCatalog[theme];
		const title = entry.title;
		const credit = getCredit(entry);

		return `* [__${title}__](${css}) (${credit})<br />\n[![${title}](${screenshot})](${css})`;
	}).join('\n\n');

	const readmePath = path.join(__dirname, 'README.md');
	let readme = await fs.readFile(readmePath, 'utf-8');
	readme = readme.replace(/(## Available themes)[\s\S]*/, (m, header) => {
		return `${header}\n\n${md}\n`;
	});

	await fs.writeFile(readmePath, readme, 'utf-8');
}

/**
 * Checks that all themes have a screenshot.
 */
async function checkScreenshots() {
	const themes = new Set(await getThemes());
	const screenshots = new Set(await fs.readdir(screenshotDir));
	screenshots.delete('code.html');

	for (const theme of themes) {
		if (!screenshots.delete(`prism-${theme}.png`)) {
			throw new Error(`The theme "${theme}" does not have a screenshot.`);
		}
	}

	if (screenshots.size > 0) {
		throw new Error(`There are screenshots without a theme: "${[...screenshots].join('", "')}"`);
	}
}

/**
 * Checks that all themes have a CSS file.
 */
async function checkCSS() {
	const themes = new Set(await getThemes());
	const cssFiles = new Set(await fs.readdir(themesDir));

	for (const theme of themes) {
		if (!cssFiles.delete(`prism-${theme}.css`)) {
			throw new Error(`The theme "${theme}" does not have a screenshot.`);
		}
	}

	if (cssFiles.size > 0) {
		throw new Error(`There are CSS files without a theme: "${[...cssFiles].join('", "')}"`);
	}
}

/**
 * @type {Object<string, Object<string, string | RegExp>>}
 */
const requirements = {
	'pre': {
		/* Code block: pre */

		'overflow': 'auto'
	},
	'pre > code': {
		/* Code block: code */

		'font-size': /^(?:1em|)$/
	},
	':not(pre) > code': {
		/* Inline: code */

		// none
	}
};

async function checkRequirements() {
	const getSource = css => {
		return `
			<!DOCTYPE html>
			<html>
			<head>
				<style>${css}</style>
			</head>
			<body>
				<!-- Code block -->
				<pre class="language-javascript"><code class="language-javascript">var a = 0;</code></pre>

				<!-- Inline code -->
				<code class="language-javascript">a++</code>
			</body>
			</html>
		`;
	};

	let pass = true;

	for (const theme of await getThemes()) {
		const dom = new JSDOM(getSource(await fs.readFile(getThemePath(theme), 'utf-8')));

		for (const selector in requirements) {
			const properties = requirements[selector];

			for (const element of dom.window.document.querySelectorAll(selector)) {
				const style = dom.window.getComputedStyle(element);

				for (const property in properties) {
					const expected = properties[property];
					const actual = style[property];

					let valid;
					if (typeof expected === 'string') {
						valid = expected === actual;
					} else {
						valid = expected.test(actual);
					}

					if (!valid) {
						pass = false;
						console.error(`${theme} does not meet the requirement for "${selector}":\n` +
							`  Expected the ${property} property to be ${expected} but found "${actual}"`);
					}
				}
			}
		}
	}

	if (!pass) {
		throw new Error('Some checks failed.');
	}
}


function cleanTitleUp(title) {
	if (!title) return title;
	title = title.replace(/ Theme$/i, '');
	return title.trim();
}

function cleanOwnerUp(owner) {
	if (!owner) return owner;
	owner = owner.replace(/ adapted from .*$/i, '');
	owner = owner.replace(/,\s*$/, '');
	return owner.trim();
}

function peelOwnerApart(owner) {
	let m = /^(.+?),? <(.+)>/i.exec(owner);
	if (m) {
		return {
			name: cleanOwnerUp(m[1]),
			link: m[2].trim(),
		};
	}
	m = /^(.+) \((http.+)\)/i.exec(owner);
	if (m) {
		return {
			name: cleanOwnerUp(m[1]),
			link: m[2].trim(),
		};
	}
	m = /^(.+) [\(\[]@(.+)[\)\]]/i.exec(owner);
	if (m) {
		return {
			name: cleanOwnerUp(m[1]),
			link: 'https://github.com/' + m[2].trim(),
		};
	}
	m = /^(.+):\s*(http.+)/i.exec(owner);
	if (m) {
		return {
			name: cleanOwnerUp(m[1]),
			link: m[2].trim(),
		};
	}
	m = /^(.+) from (http.+)/i.exec(owner);
	if (m) {
		return {
			name: cleanOwnerUp(m[1]),
			link: m[2].trim(),
		};
	}
	return cleanOwnerUp(owner);
}

async function discoverTheme(theme) {
	let p = getThemePath(theme);
	let css = (await fs.readFile(p, 'utf-8')).trim().replace(/(?:\r\n?)+/g, '\n');

	css = css.split("*/")[0];
	css = css.replace(/\/\*+/, '').split("\n").map(f => f.replace(/^\s*\*/, '').replace(/\t/g, ' ').trim()).filter(f => f).join('\n');

	// hacky check to see if we actually have a header to decode:
	if (css.includes('code[class')) {
		return null;
	}

 	let m = /(?:prism\.js)?(.+) theme for (.+) by (.*)/i.exec(css);
 	let title = m && m[1].trim();
 	let author = m && m[3] && m[3].trim();
	let originalOwner = null;
 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 4:\n${m} --> title: "${title}"`);

 	if (!m) {
	 	m = /(?:prism\.js)?(.+) theme for (.+)/i.exec(css);
	 	title = m && m[1].trim();
	 	author = null;
	 	if (title && title.toLowerCase().includes('based on')) {
	 		m = null;
	 		title = null;
	 	}
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 4.0:\n${m} --> title: "${title}", author: "${author}"`);
 	}
 	if (!m) {
 		m = /Name: (.+)\nAuthor: (.+)/i.exec(css);
	 	title = m && m[1].trim();
	 	author = m && m[2].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 4.1:\n${m} --> title: "${title}", author: "${author}"`);
 	}
 	if (!m) {
 		m = /(?:prism\.js)?(.+)Theme by (.+)/i.exec(css);
	 	title = m && m[1].trim();
	 	author = m && m[2].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 4.2:\n${m} --> title: "${title}", author: "${author}"`);
 	}
 	if (!m) {
 		m = /(?:prism\.js)?(.+) Originally by (.+)/i.exec(css);
	 	title = m && m[1].trim();
	 	originalOwner = m && m[2].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 4.3:\n${m} --> title: "${title}", originalOwner: "${originalOwner}"`);
 	}
 	if (!m) {
 		m = /(?:prism\.js)?(.+)[\s\n]+(?:Theme )?by (.+)/i.exec(css);
	 	title = m && m[1].trim();
	 	author = m && m[2].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 4.4:\n${m} --> title: "${title}", author: "${author}"`);
 	}

 	if (!author) {
 		m = /^@author(.+)/im.exec(css);
	 	author = m && m[1].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 4.5:\n${m} --> title: "${title}", author: "${author}"`);
 	}
 	if (!author) {
 		m = /^Author: (.+)/im.exec(css);
	 	author = m && m[1].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 4.6:\n${m} --> title: "${title}", author: "${author}"`);
 	}
 	if (!author) {
 		m = /^Ported for PrismJS by (.+)/im.exec(css);
	 	author = m && m[1].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 4.7:\n${m} --> title: "${title}", author: "${author}"`);
 	}

 	if (!title) {
 		title = css.split('\n')[0].trim();
 		if (!title) {
 			title = null;
 		}
 	}

 	let basedOn = null;
 	m = /^based on (.+)'s (.+ theme for prism\.js)/im.exec(css);
 	if (m) {
	 	basedOn = m && m[2].trim();
	 	originalOwner = m && m[1].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 5:\n${m} --> basedOn: "${basedOn}"`);
	}
 	if (!basedOn) {
	 	m = /^based on (.+)/im.exec(css);
	 	let basedOn = m && m[1].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 5.0:\n${m} --> basedOn: "${basedOn}"`);
	}
 	if (!basedOn) {
	 	m = /based on:[\s\n]+(.+)/im.exec(css);
	 	basedOn = m && m[1].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 5.1:\n${m} --> basedOn: "${basedOn}"`);
	}
 	if (!basedOn) {
	 	m = /^inspired by (.+)/im.exec(css);
	 	basedOn = m && m[1].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 5.2:\n${m} --> basedOn: "${basedOn}"`);
	}
 	if (!basedOn) {
	 	m = /^original (.+)/im.exec(css);
	 	basedOn = m && m[1].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 5.3:\n${m} --> basedOn: "${basedOn}"`);
	}
 	if (!basedOn) {
	 	m = /\badapted from (.+)/im.exec(css);
	 	basedOn = m && m[1].trim();
	 	if (DEBUG) console.error(`\n\n################################\ndiscover CSS 5.4:\n${m} --> basedOn: "${basedOn}"`);
	}

	if (basedOn && !originalOwner) {
		m = /(.+) by (.+)/i.exec(basedOn);
		if (m) {
			originalOwner = m[2].trim();
			basedOn = m[1].trim();
		}
	}

	// peel the authors apart into name+link where-ever possible:
	author = peelOwnerApart(author);
	originalOwner = peelOwnerApart(originalOwner);
	basedOn = peelOwnerApart(basedOn);

	return {
		title: cleanTitleUp(title || theme),
		owner: author || originalOwner || undefined,
		basedOn: basedOn || undefined,
		originalOwner: originalOwner || undefined,
	};
}


async function discoverThemes(themes, verbose) {
	// first scan the themese directory:
	let dirlist = (await fs.readdir(themesDir)).map(f => (/^.+(?=\.css$)/.exec(f) || [''])[0].replace(/^prism-/, '')).filter(f => f);
	let change = false;

	for (const theme of dirlist) {
		if (!themes[theme]) {
			if (verbose) console.error(`Theme ${theme} is not yet listed in themes.json.`);
			let rec = await discoverTheme(theme);
			if (rec) {
				if (verbose) console.error(`--> Theme ${theme} added to set in themes.json.`);
				change = true;
				themes[theme] = rec;
			}
		}
	}

	return change;
}

exports['update-readme'] = updateReadme;
exports.screenshot = screenshotMissingThemes;
exports['screenshot-all'] = screenshotAllThemes;
exports.build = parallel(screenshotMissingThemes, updateReadme);

exports.check = parallel(checkScreenshots, checkCSS, checkRequirements)
exports.regenThemeSetFromScratch = async () => {
	if (10) {
		await getThemes(true);
	} else {
		console.error(JSON.stringify([
			await discoverTheme('coy-without-shadows'),
			await discoverTheme('dracula'),
			await discoverTheme('nord'),
			await discoverTheme('xonokai'),
			await discoverTheme('darcula'),
		], null, 2));
	}
}
