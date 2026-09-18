// /rfq was a screen where a person uploaded a document by hand. That is not
// what this system is for: a quote request arrives at the order desk as mail
// with something attached, and the agent reads it. Everything that screen did
// is part of the desk now, hand entry included, so this address only points
// at the desk.
//
// 308 and not 302: the method is preserved and browsers and crawlers are told
// the move is permanent, which is what it is.
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	redirect(308, '/desk');
};
