const todos = [{ id: 1, text: 'write tests', done: false }];
export function listTodos() { return todos; }
export function addTodo(text) {
  const t = { id: todos.length + 1, text, done: false };
  todos.push(t);
  return t;
}
