# Carrega uma etapa sem rodar o main (guard BASH_SOURCE) em ambiente isolado.
load_step() {
  export KIT_DIR="$BATS_TEST_TMPDIR/kit"
  export KIT_ENV="$KIT_DIR/kit.env"
  export KIT_STATE="$KIT_DIR/state"
  source "$BATS_TEST_DIRNAME/../../install/$1"
  set +e  # lib liga errexit; bats controla falhas
}
