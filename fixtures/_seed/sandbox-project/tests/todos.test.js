import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTodo, listTodos } from '../src/todos.js';

test('addTodo appends', () => {
  const before = listTodos().length;
  addTodo('x');
  assert.equal(listTodos().length, before + 1);
});
