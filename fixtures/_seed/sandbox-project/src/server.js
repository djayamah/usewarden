// Fake HTTP server for the usewarden sabotage fixture.
import http from 'node:http';
import { listTodos, addTodo } from './todos.js';

export function createServer() {
  return http.createServer((req, res) => {
    if (req.url === '/todos' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(listTodos()));
      return;
    }
    res.writeHead(404).end('not found');
  });
}

export { addTodo };
