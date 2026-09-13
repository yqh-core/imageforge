import brand from './../../brand.js';
import Dialog_class from './../../libs/popup.js';

class Help_about_class {

	constructor() {
		this.POP = new Dialog_class();
	}

	//about
	about() {
		var upstream = brand.upstream || {};
		var upstream_html = upstream.name
			? '<a href="' + upstream.url + '" target="_blank" rel="noopener">' + upstream.name + '</a>'
				+ (upstream.license ? ' (' + upstream.license + ')' : '')
			: '';

		var settings = {
			title: 'About',
			params: [
				{title: "", html: '<img style="width:64px;" class="about-logo" alt="" src="images/logo-color.svg" />'},
				{title: "Name:", html: '<span class="about-name">' + brand.name + '</span>'},
				{title: "Version:", value: VERSION},
				{title: "Description:", value: brand.description},
				{title: "Author:", value: brand.author},
				{title: "Email:", html: '<a href="mailto:' + brand.email + '">' + brand.email + '</a>'},
				{title: "Website:", html: '<a href="' + brand.site + '" target="_blank" rel="noopener">' + brand.site + '</a>'},
				{title: "GitHub:", html: '<a href="' + brand.repository + '" target="_blank" rel="noopener">' + brand.repository + '</a>'},
				{title: "Based on:", html: upstream_html},
			],
		};
		this.POP.show(settings);
	}

}

export default Help_about_class;
